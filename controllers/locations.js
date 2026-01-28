const express = require("express");
const verifyToken = require("../middleware/verify-token.js");
const Location = require("../models/location.js");
const router = express.Router();

const API_KEY = process.env.API_KEY;

// ------------------------------
// Simple in-memory TTL caches
// ------------------------------
const placesCache = new Map();   // key: search string -> { expiresAt, value }
const pointsCache = new Map();   // key: "lat,lon" -> { expiresAt, value }  (value: forecastUrl)
const forecastCache = new Map(); // key: forecastUrl -> { expiresAt, value } (value: periods[])

const nowMs = () => Date.now();
const cacheGet = (map, key) => {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= nowMs()) {
    map.delete(key);
    return null;
  }
  return hit.value;
};
const cacheSet = (map, key, value, ttlMs) => {
  map.set(key, { value, expiresAt: nowMs() + ttlMs });
};

const roundCoord = (v) => Number(v).toFixed(4);
const toNum = (v) => (v === "" || v == null ? null : Number(v));

const TTL = {
  places: 10 * 60 * 1000,          // 10m (autocomplete)
  points: 7 * 24 * 60 * 60 * 1000, // 7d (points -> forecast URL rarely changes)
  forecast: 10 * 60 * 1000,        // 10m (forecast refresh cadence)
};

const NWS_HEADERS = {
  "User-Agent":
    process.env.NWS_USER_AGENT ||
    "Trailcast (example@example.com)", // set NWS_USER_AGENT in prod
  Accept: "application/geo+json, application/json",
  "Accept-Language": "en-US",
};

const fetchJson = async (url, options = {}) => {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Request failed: ${res.status}`);
    err.status = res.status;
    err.details = text.slice(0, 300);
    throw err;
  }
  return res.json();
};

const getForecastForLatLon = async (lat, lon) => {
  const latNum = toNum(lat);
  const lonNum = toNum(lon);
  if (latNum == null || lonNum == null || Number.isNaN(latNum) || Number.isNaN(lonNum)) {
    const err = new Error("lat and lon must be valid numbers");
    err.status = 400;
    throw err;
  }

  const coordKey = `${roundCoord(latNum)},${roundCoord(lonNum)}`;

  // 1) points -> forecast URL (cache long)
  let forecastUrl = cacheGet(pointsCache, coordKey);
  if (!forecastUrl) {
    const pointsData = await fetchJson(
      `https://api.weather.gov/points/${latNum},${lonNum}`,
      { headers: NWS_HEADERS }
    );

    forecastUrl = pointsData?.properties?.forecast;
    if (!forecastUrl) {
      const err = new Error("NWS points response missing forecast URL");
      err.status = 502;
      throw err;
    }

    cacheSet(pointsCache, coordKey, forecastUrl, TTL.points);
  }

  // 2) forecast URL -> periods (cache short)
  let periods = cacheGet(forecastCache, forecastUrl);
  if (!periods) {
    const forecastData = await fetchJson(forecastUrl, { headers: NWS_HEADERS });
    periods = forecastData?.properties?.periods ?? [];
    cacheSet(forecastCache, forecastUrl, periods, TTL.forecast);
  }

  return periods;
};

const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
};

// ------------------------------
// Routes
// ------------------------------

// GET ALL LOCATIONS
router.get("/", async (req, res) => {
  try {
    const locations = await Location.find({})
      .populate("author")
      .sort({ createdAt: -1 });

    res.status(200).json(locations);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

// SEARCH LOCATIONS (GEOAPIFY AUTOCOMPLETE)
router.get("/places", async (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    if (!search) {
      return res.status(200).json({ places: [] });
    }
    if (!API_KEY) {
      return res.status(500).json({ err: "Missing API_KEY for Geoapify" });
    }

    const cacheKey = search.toLowerCase();
    const cached = cacheGet(placesCache, cacheKey);
    if (cached) return res.json(cached);

    const url =
      `https://api.geoapify.com/v1/geocode/autocomplete?` +
      `text=${encodeURIComponent(search)}` +
      `&filter=countrycode:us` +
      `&limit=10` +
      `&apiKey=${API_KEY}`;

    const data = await fetchJson(url);

    const places = (data.features || []).map((feature) => ({
      name: feature.properties.formatted,
      place_id: feature.properties.place_id,
      longitude: feature.properties.lon,
      latitude: feature.properties.lat,
    }));

    const payload = { places };
    cacheSet(placesCache, cacheKey, payload, TTL.places);

    // Important: empty results are NOT an error for autocomplete UX
    return res.json(payload);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ err: err.message, details: err.details });
  }
});

// WEATHER (NWS) - single
router.get("/weather", async (req, res) => {
  try {
    const { lat, lon, name } = req.query;
    const periods = await getForecastForLatLon(lat, lon);

    res.json({
      location: {
        name: name ?? null,
        lat: Number(lat),
        lon: Number(lon),
        forecast: periods,
      },
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ err: err.message, details: err.details });
  }
});

// WEATHER (NWS) - batch
router.post("/weather/batch", async (req, res) => {
  try {
    const locations = Array.isArray(req.body?.locations) ? req.body.locations : [];
    if (!locations.length) return res.json({ results: [] });

    // Keep this conservative to protect NWS (and your server)
    if (locations.length > 50) {
      return res.status(413).json({ err: "Too many locations. Max 50." });
    }

    const results = await mapWithConcurrency(locations, 6, async (loc) => {
      const lat = loc?.lat ?? loc?.latitude;
      const lon = loc?.lon ?? loc?.longitude;
      const name = loc?.name ?? null;

      try {
        const forecast = await getForecastForLatLon(lat, lon);
        return {
          name,
          lat: Number(lat),
          lon: Number(lon),
          forecast,
        };
      } catch (e) {
        return {
          name,
          lat: lat != null ? Number(lat) : null,
          lon: lon != null ? Number(lon) : null,
          forecast: null,
          error: e.message,
        };
      }
    });

    res.json({ results });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

// CREATE LOCATION
router.post("/", verifyToken, async (req, res) => {
  try {
    const location = await Location.create({
      ...req.body,
      author: req.user._id,
    });

    res.status(201).json(location);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});


// UPDATE LOCATION
router.put("/:locationId", verifyToken, async (req, res) => {
  try {
    const location = await Location.findById(req.params.locationId);
    if (!location) return res.status(404).json({ err: "Location not found" });

    if (!location.author.equals(req.user._id)) {
      return res.status(403).send("You're not allowed to make changes!");
    }

    const updatedLocation = await Location.findByIdAndUpdate(
      req.params.locationId,
      req.body,
      { new: true }
    ).populate("author");

    res.status(200).json(updatedLocation);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

// DELETE LOCATION
router.delete("/:locationId", verifyToken, async (req, res) => {
  try {
    const location = await Location.findById(req.params.locationId);
    if (!location) return res.status(404).json({ err: "Location not found" });

    if (!location.author.equals(req.user._id)) {
      return res.status(403).send("You can't delete this entry, you're not the author!");
    }

    const deletedLocation = await Location.findByIdAndDelete(req.params.locationId);
    res.status(200).json(deletedLocation);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

//matching by coord -location

router.get('/by-coords', async (req, res) => {
  const { lat, lon } = req.query;

  console.log(lat,lon);
  

  if (!lat || !lon) {
    return res.status(400).json({ error: 'Latitude and longitude are required' });
  }

  try {
    const location = await Location.findOne({
      latitude: Number(lat),
      longitude: Number(lon),
    }).populate('activities.author', 'username'); 

    const comment = location.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ err: "Comment not found" });

    if (!comment.author.equals(req.user._id)) {
      return res.status(403).json({
        message: "You are not authorized to change this comment, you're not the author",
      });
    }

    res.status(200).json(location);
  } catch (err) {
    console.error('Error fetching location by coords:', err);
    res.status(500).json({ error: err.message });
  }
});


//activities
router.post("/:locationId/activities", verifyToken, async (req, res) => {
  try {
    const location = await Location.findById(req.params.locationId);
    if (!location) return res.status(404).json({ err: "Location not found" });
   
    const activityData = { ...req.body, author: req.user._id };
    location.activities.push(activityData);
    await location.save();

    await location.populate({
      path: 'activities.author',
      select: 'username'
    });

    const newActivity = location.activities[location.activities.length - 1];
    res.status(201).json(newActivity);

  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

//update activity
router.put("/:locationId/activities/:activityId", verifyToken, async (req, res) => {
  try {
    const location = await Location.findById(req.params.locationId);
    if (!location) {
      return res.status(404).json({ err: "Location not found" });
    }

    const activity = location.activities.id(req.params.activityId);
    if (!activity) {
      return res.status(404).json({ err: "Activity not found" });
    }

    if (!activity.author || activity.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized" });
    }

    activity.text = req.body.text;
    activity.day = req.body.day;

    await location.save();

    const populatedLocation = await location.populate({
      path: 'activities.author',
      select: 'username'
    });

    const updatedActivity = populatedLocation.activities.id(activity._id);

    res.status(200).json(updatedActivity);

  } catch (err) {
    console.error("Update activity error:", err);
    res.status(500).json({ err: err.message });
  }
});


// delete activity
router.delete("/:locationId/activities/:activityId", verifyToken, async (req, res) => {
  try {
    const location = await Location.findById(req.params.locationId);
    if (!location) return res.status(404).json({ err: "Location not found" });

    const activity = location.activities.id(req.params.activityId);
    if (!activity) return res.status(404).json({ err: "Comment not found" });

    if (!activity.author.equals(req.user._id)) {
      return res.status(403).json({ message: "You are not authorized to delete this comment" });
    }

    location.comments.pull(req.params.commentId);
    await location.save();

    res.status(200).json({ message: "Comment deleted successfully" });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

// CREATE LOG
router.post("/:locationId/logs", verifyToken, async (req, res) => {
  try {
    req.body.author = req.user._id;

    const location = await Location.findById(req.params.locationId);
    if (!location) return res.status(404).json({ err: "Location not found" });

    location.logs.push(req.body);
    await location.save();

    const newLog = location.logs[location.logs.length - 1];
    newLog._doc.author = req.user;

    res.status(201).json(newLog);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

// UPDATE LOG
router.put("/:locationId/logs/:logId", verifyToken, async (req, res) => {
  try {
    const location = await Location.findById(req.params.locationId);
    if (!location) return res.status(404).json({ err: "Location not found" });

    const log = location.logs.id(req.params.logId);
    if (!log) return res.status(404).json({ err: "Log not found" });

    if (!log.author.equals(req.user._id)) {
      return res.status(403).json({
        message: "You are not authorized to change this activity, you're not the author",
      });
    }

    log.text = req.body.text;
    await location.save();

    res.status(200).json(log);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

// DELETE LOG
router.delete("/:locationId/logs/:logId", verifyToken, async (req, res) => {
  try {
    const location = await Location.findById(req.params.locationId);
    if (!location) return res.status(404).json({ err: "Location not found" });

    const log = location.logs.id(req.params.logId);
    if (!log) return res.status(404).json({ err: "Log not found" });

    if (!log.author.equals(req.user._id)) {
      return res.status(403).json({ message: "You are not authorized to delete this activity" });
    }

    location.logs.pull(req.params.logId);
    await location.save();

    res.status(200).json({ message: "Activity deleted successfully" });
  } catch (err) {
    console.error("Update activity error:", err);
    res.status(500).json({ err: err.message });
  }
});



module.exports = router;
