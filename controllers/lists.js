const express = require("express");
const verifyToken = require("../middleware/verify-token.js");
const List = require("../models/list.js");
const Location = require("../models/location.js");

const router = express.Router();

/* Helper: ensure the current user owns the list (for write ops) */
async function getOwnedList(listId, userId) {
  const list = await List.findById(listId);
  if (!list) return { error: { status: 404, msg: "List not found" } };
  if (!list.owner.equals(userId)) return { error: { status: 403, msg: "Forbidden" } };
  return { list };
}

/* Helper: allow viewing any list (read-only) */
async function getListById(listId) {
  const list = await List.findById(listId);
  if (!list) return { error: { status: 404, msg: "List not found" } };
  return { list };
}

/**
 * Normalize coords into a deterministic key for de-duping within a list.
 * Uses 1e6 scaling to avoid float/string differences (e.g. "37.77" vs "37.7700").
 */
function coordKeyFrom(lon, lat) {
  const lo = Number(lon);
  const la = Number(lat);
  if (!Number.isFinite(lo) || !Number.isFinite(la)) return null;

  const loE6 = Math.round(lo * 1e6);
  const laE6 = Math.round(la * 1e6);
  return `${loE6}|${laE6}`;
}

/* Get all lists for current user */
router.get("/", verifyToken, async (req, res) => {
  try {
    const lists = await List.find({ owner: req.user._id })
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json(lists);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/* Create a new list: body: { name, description? } */
router.post("/", verifyToken, async (req, res) => {
  try {
    const { name, description = "" } = req.body;
    if (!name) return res.status(400).json({ err: "name is required" });

    const created = await List.create({
      name,
      description,
      owner: req.user._id,
      locations: [],
    });

    res.status(201).json(created);
  } catch (err) {
    // handles unique index { owner, name }
    if (err.code === 11000) {
      return res.status(409).json({ err: "You already have a list with that name." });
    }
    res.status(500).json({ err: err.message });
  }
});

/**
 * GET /lists/search?q=...
 * Search lists across ALL users (read-only).
 * Keep verifyToken so only signed-in users can search.
 */
router.get("/search", verifyToken, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.status(200).json({ lists: [] });

    // Escape regex specials to prevent weird regex behavior
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(escaped, "i");

    const lists = await List.find({
      $or: [{ name: rx }, { description: rx }],
    })
      .select("name description owner updatedAt")
      .populate("owner", "username")
      .sort({ updatedAt: -1 })
      .limit(12)
      .lean();

    res.status(200).json({ lists });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/**
 * Get one list (viewable by any signed-in user)
 * Returns populated locations and sorted by order.
 */
router.get("/:listId", verifyToken, async (req, res) => {
  try {
    const { list, error } = await getListById(req.params.listId);
    if (error) return res.status(error.status).json({ err: error.msg });

    await list.populate({
      path: "locations.location",
      select: "name longitude latitude description author",
      populate: { path: "author", select: "username" },
    });

    await list.populate({ path: "owner", select: "username" });

    const sorted = list.locations
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    res.status(200).json({
      ...list.toObject(),
      locations: sorted,
    });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/* Update list metadata (name/description) — owner-only */
router.put("/:listId", verifyToken, async (req, res) => {
  try {
    const { list, error } = await getOwnedList(req.params.listId, req.user._id);
    if (error) return res.status(error.status).json({ err: error.msg });

    const { name, description } = req.body;
    if (name !== undefined) list.name = name;
    if (description !== undefined) list.description = description;

    await list.save();
    res.status(200).json(list);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ err: "You already have a list with that name." });
    }
    res.status(500).json({ err: err.message });
  }
});

/* Delete a list — owner-only */
router.delete("/:listId", verifyToken, async (req, res) => {
  try {
    const { list, error } = await getOwnedList(req.params.listId, req.user._id);
    if (error) return res.status(error.status).json({ err: error.msg });

    await list.deleteOne();
    res.status(200).json({ message: "List deleted" });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/**
 * Add a location to a list (owner-only)
 *
 * body can be:
 *   - { locationId }
 * OR
 *   - { name, longitude, latitude, description? }
 *
 * Prevents duplicates by:
 *   - locationId
 *   - coordinate key (lon/lat) within the same list
 */
router.post("/:listId/locations", verifyToken, async (req, res) => {
  try {
    const { list, error } = await getOwnedList(req.params.listId, req.user._id);
    if (error) return res.status(error.status).json({ err: error.msg });

    let locationId = req.body.locationId;

    // If client sent raw location data, upsert a Location doc (per-user uniqueness)
    if (!locationId) {
      const { name, longitude, latitude, description = "" } = req.body;

      const lon = Number(longitude);
      const lat = Number(latitude);

      if (!name || !Number.isFinite(lon) || !Number.isFinite(lat)) {
        return res.status(400).json({
          err: "locationId or (name, longitude, latitude) required (numbers)",
        });
      }

      const upserted = await Location.findOneAndUpdate(
        { author: req.user._id, longitude: lon, latitude: lat },
        {
          $setOnInsert: {
            author: req.user._id,
            longitude: lon,
            latitude: lat,
            description,
          },
          $set: { name },
        },
        { new: true, upsert: true }
      );

      locationId = upserted._id;
    }

    // Duplicate check by locationId
    const alreadyById = list.locations.some(
      (e) => e.location.toString() === locationId.toString()
    );
    if (alreadyById) return res.status(409).json({ err: "Location already in this list" });

    // Duplicate check by coordinates (handles different Location docs with same lon/lat)
    // Get lon/lat for the candidate:
    let lon;
    let lat;

    if (req.body.locationId) {
      const locDoc = await Location.findById(locationId).select("longitude latitude");
      if (!locDoc) return res.status(404).json({ err: "Location not found" });
      lon = locDoc.longitude;
      lat = locDoc.latitude;
    } else {
      lon = Number(req.body.longitude);
      lat = Number(req.body.latitude);
    }

    const coordKey = coordKeyFrom(lon, lat);
    if (!coordKey) return res.status(400).json({ err: "Invalid coordinates" });

    // Populate minimal coords to compare against existing entries (back-compat if coordKey missing)
    await list.populate({ path: "locations.location", select: "longitude latitude" });

    const alreadyByCoords = list.locations.some((entry) => {
      if (entry.coordKey) return entry.coordKey === coordKey;
      const l = entry.location;
      if (!l) return false;
      return coordKeyFrom(l.longitude, l.latitude) === coordKey;
    });

    if (alreadyByCoords) {
      return res.status(409).json({ err: "A location with those coordinates is already in this list" });
    }

    // set order = max + 1
    const maxOrder = list.locations.reduce((m, e) => Math.max(m, e.order ?? 0), -1);

    list.locations.push({
      location: locationId,
      order: maxOrder + 1,
      addedAt: new Date(),
      coordKey, // requires coordKey field in your list schema to persist
    });

    await list.save();

    await list.populate({
      path: "locations.location",
      select: "name longitude latitude description author",
      populate: { path: "author", select: "username" },
    });

    const sorted = list.locations.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    res.status(201).json({ ...list.toObject(), locations: sorted });
  } catch (err) {
    // Handles race-condition duplicates from unique indexes (if you add them)
    if (err.code === 11000) {
      return res.status(409).json({ err: "Location (or coordinates) already in this list" });
    }
    res.status(500).json({ err: err.message });
  }
});

/* Remove a location from a list — owner-only */
router.delete("/:listId/locations/:locationId", verifyToken, async (req, res) => {
  try {
    const { list, error } = await getOwnedList(req.params.listId, req.user._id);
    if (error) return res.status(error.status).json({ err: error.msg });

    const locationId = req.params.locationId;

    const before = list.locations.length;
    list.locations = list.locations.filter(
      (e) => e.location.toString() !== locationId.toString()
    );

    if (list.locations.length === before) {
      return res.status(404).json({ err: "Location not in this list" });
    }

    await list.save();

    await list.populate({
      path: "locations.location",
      select: "name longitude latitude description author",
      populate: { path: "author", select: "username" },
    });

    const sorted = list.locations.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    res.status(200).json({ ...list.toObject(), locations: sorted });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/* Drag/drop reorder — owner-only */
router.put("/:listId/reorder", verifyToken, async (req, res) => {
  try {
    const { list, error } = await getOwnedList(req.params.listId, req.user._id);
    if (error) return res.status(error.status).json({ err: error.msg });

    const { orderedLocationIds } = req.body;
    if (!Array.isArray(orderedLocationIds)) {
      return res.status(400).json({ err: "orderedLocationIds must be an array" });
    }

    const currentIds = list.locations.map((e) => e.location.toString());
    const incomingIds = orderedLocationIds.map(String);

    // Validate same set (no missing/extra)
    const currentSet = new Set(currentIds);
    const incomingSet = new Set(incomingIds);

    if (currentSet.size !== incomingSet.size) {
      return res.status(400).json({ err: "orderedLocationIds must match list contents" });
    }
    for (const id of currentSet) {
      if (!incomingSet.has(id)) {
        return res.status(400).json({ err: "orderedLocationIds must match list contents" });
      }
    }

    // Update orders
    const orderMap = new Map(incomingIds.map((id, idx) => [id, idx]));
    list.locations.forEach((entry) => {
      entry.order = orderMap.get(entry.location.toString());
    });

    await list.save();

    await list.populate({
      path: "locations.location",
      select: "name longitude latitude description author",
      populate: { path: "author", select: "username" },
    });

    const sorted = list.locations.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    res.status(200).json({ ...list.toObject(), locations: sorted });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

module.exports = router;
