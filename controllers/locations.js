const express = require("express");
const verifyToken = require("../middleware/verify-token.js");
const Location = require("../models/location.js");
const router = express.Router();

const API_KEY = process.env.API_KEY;

// GET ALL LOCATIONS
router.get("/", async (req, res) => {
  try {
    // List ordering should be handled inside List.locations[].order.
    const locations = await Location.find({})
      .populate("author")
      .sort({ createdAt: -1 }); // default sort newest first

    res.status(200).json(locations);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

// SEARCH LOCATIONS (GEOAPIFY)
router.get("/places", async (req, res) => {
  try {
    const search = req.query.search;
    if (!search) {
      return res.status(400).json({ err: "Search query is required" });
    }

    const response = await fetch(
      `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(search)}&filter=countrycode:us&apiKey=${API_KEY}`
    );

    if (!response.ok) {
      return res.status(response.status).json({ err: "Geoapify request failed" });
    }


    const data = await response.json();

    if (!data.features?.length) {
      return res.status(404).json({ err: "No places found" });
    }

    const places = data.features.map((feature) => ({
      name: feature.properties.formatted,
      place_id: feature.properties.place_id,
      longitude: feature.properties.lon,
      latitude: feature.properties.lat,
    }));

    res.json({ places });
  } catch (err) {
    console.error(err);
    res.status(500).json({ err: err.message });
  }
});

// WEATHER (NWS)
router.get("/weather", async (req, res) => {
  try {
    const { lat, lon, name } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({ err: "lat and lon are required" });
    }

    const pointsResponse = await fetch(`https://api.weather.gov/points/${lat},${lon}`);

    // Handle non-200 from NWS
    if (!pointsResponse.ok) {
      const text = await pointsResponse.text(); // may be HTML
      return res.status(pointsResponse.status).json({
        err: "NWS points request failed",
        details: text.slice(0, 200),
      });
    }

    const pointsData = await pointsResponse.json();
    const forecastUrl = pointsData?.properties?.forecast;

    if (!forecastUrl) {
      return res.status(502).json({ err: "NWS points response missing forecast URL" });
    }

    const forecastResponse = await fetch(forecastUrl);

    if (!forecastResponse.ok) {
      const text = await forecastResponse.text(); // may be HTML
      return res.status(forecastResponse.status).json({
        err: "NWS forecast request failed",
        details: text.slice(0, 200),
      });
    }

    const forecastData = await forecastResponse.json();
    const weather = forecastData?.properties?.periods ?? [];

    res.json({
      location: {
        name: name ?? null,
        lat: Number(lat),
        lon: Number(lon),
        forecast: weather,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ err: err.message });
  }
});

// CREATE LOCATION
router.post("/", verifyToken, async (req, res) => {
  try {
    // ordering for a list should happen inside List.locations[].order.
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

    // If you need the author populated as the current user immediately:
    // updatedLocation._doc.author = req.user;

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

    console.log (location);

    if (!location) {
      return res.status(404).json({ error: 'Location not found' });
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

    // FIX: pull is safer / cleaner than remove({ _id: ... })
    location.activities.pull(req.params.activityId);
    await location.save();

    res.status(200).json({ message: "Activity deleted successfully" });
  } catch (err) {
    console.error("Update activity error:", err);
    res.status(500).json({ err: err.message });
  }
});



module.exports = router;
