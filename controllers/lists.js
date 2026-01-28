const express = require("express");
const verifyToken = require("../middleware/verify-token.js");
const List = require("../models/list.js");
const Location = require("../models/location.js");

const router = express.Router();

/**
 * Helper: ensure the current user owns the list
 */
async function getOwnedList(listId, userId) {
  const list = await List.findById(listId);
  if (!list) return { error: { status: 404, msg: "List not found" } };
  if (!list.owner.equals(userId)) return { error: { status: 403, msg: "Forbidden" } };
  return { list };
}

/**
 * GET /lists
 * Get all lists for current user
 */
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

/**
 * POST /lists
 * Create a new list
 * body: { name, description? }
 */
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
 * GET /lists/:listId
 * Get one list + populated locations
 */
router.get("/:listId", verifyToken, async (req, res) => {
  try {
    const { list, error } = await getOwnedList(req.params.listId, req.user._id);
    if (error) return res.status(error.status).json({ err: error.msg });

    // populate and sort by order
    await list.populate([
      {
        path: "locations.location",
        populate: { path: "author" }, // optional
      },
      {
        path: "comments.owner",
        select: "username", // only fetch username for frontend
      },
    ]);

    // ensure consistent order on response
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

/**
 * PUT /lists/:listId
 * Update list metadata (name/description)
 */
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

/**
 * DELETE /lists/:listId
 * Delete a list
 */
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
 * POST /lists/:listId/locations
 * Add a location to a list (create the Location doc if needed)
 *
 * body can be:
 *   - { locationId }  (if location already exists in DB)
 * OR
 *   - { name, longitude, latitude, description? } (create new Location doc then add)
 *
 * Returns updated list (sorted, populated)
 */
router.post("/:listId/locations", verifyToken, async (req, res) => {
  try {
    const { list, error } = await getOwnedList(req.params.listId, req.user._id);
    if (error) return res.status(error.status).json({ err: error.msg });

    let locationId = req.body.locationId;

    // If client sent raw location data, upsert a Location doc (so it can belong to many lists)
    if (!locationId) {
      const { name, longitude, latitude, description = "" } = req.body;

      const lon = Number(longitude);
      const lat = Number(latitude);

      if (!name || !Number.isFinite(lon) || !Number.isFinite(lat)) {
        return res.status(400).json({ err: "locationId or (name, longitude, latitude) required (numbers)" });
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

    // prevent duplicates in the list
    const already = list.locations.some((e) => e.location.toString() === locationId.toString());
    if (already) return res.status(409).json({ err: "Location already in this list" });

    // set order = max + 1
    const maxOrder = list.locations.reduce((m, e) => Math.max(m, e.order ?? 0), -1);
    list.locations.push({
      location: locationId,
      order: maxOrder + 1,
      addedAt: new Date(),
    });

    await list.save();

    await list.populate({
      path: "locations.location",
      populate: { path: "author" },
    });
    const sorted = list.locations.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    res.status(201).json({ ...list.toObject(), locations: sorted });
  } catch (err) {
  // Handles race-condition duplicates from the unique index on (_id, locations.location)
  if (err.code === 11000) {
    return res.status(409).json({ err: "Location already in this list" });
  }
  res.status(500).json({ err: err.message });
}})

/**
 * DELETE /lists/:listId/locations/:locationId
 * Remove a location from a list
 */
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

    await list.populate("locations.location");
    const sorted = list.locations.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    res.status(200).json({ ...list.toObject(), locations: sorted });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/**
 * PUT /lists/:listId/reorder
 * Drag/drop reorder
 *
 * body: { orderedLocationIds: ["<locId>", "<locId>", ...] }
 * Must contain exactly the locations currently in the list (same set).
 *
 * This is the simplest, safest approach: renumber 0..n-1 on every reorder.
 */
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

    await list.populate("locations.location");
    const sorted = list.locations.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    res.status(200).json({ ...list.toObject(), locations: sorted });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

router.post("/:listId/comments", verifyToken, async (req, res) => {
  try {
    const { list, error } = await getOwnedList(req.params.listId, req.user._id);
    if (error) return res.status(error.status).json({ err: error.msg });

    // Save owner in the comment
    const commentData = { ...req.body, owner: req.user._id };
    list.comments.push(commentData);
    await list.save();

    const newComment = list.comments[list.comments.length - 1];

    await newComment.populate('owner', 'username');

    res.status(201).json(newComment);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

// UPDATE COMMENT
router.put("/:listId/comments/:commentId", verifyToken, async (req, res) => {
  try {
    const { list, error } = await getOwnedList(req.params.listId, req.user._id);
    if (error) return res.status(error.status).json({ err: error.msg });

    const comment = list.comments.id(req.params.commentId);
      if (!comment) return res.status(404).json({ err: "Comment not found" });

      if (!comment.owner || comment.owner.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Not authorized" });
      }

      if (!req.body.text || typeof req.body.text !== 'string') {
        return res.status(400).json({ err: "Text is required" });
      }

    comment.text = req.body.text;
    console.log (comment);
    
    await list.save();
    const populatedList = await list.populate({
      path: 'comments.owner',
      select: 'username'
    });

    const updatedComment = populatedList.comments.id(comment._id);
    res.status(200).json(updatedComment);

  } catch (err) {
    console.error("Update comment error:", err);
    res.status(500).json({ err: err.message });
  }
});

// DELETE COMMENT
router.delete("/:listId/comments/:commentId", verifyToken, async (req, res) => {
  try {
    const { list, error } = await getOwnedList(req.params.listId, req.user._id);
    if (error) return res.status(error.status).json({ err: error.msg });

    const comment = list.comments.id(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ err: "Comment not found" });
    }

    if (!comment.owner.equals(req.user._id)) {
      return res.status(403).json({
        message: "You are not authorized to delete this comment",
      });
    }

    list.comments.pull(req.params.commentId);
    await list.save();

    res.status(200).json({ message: "Comment deleted successfully" });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});


module.exports = router;