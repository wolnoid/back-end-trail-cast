const express = require("express");
const verifyToken = require("../middleware/verify-token.js");
const Location = require("../models/location.js");
const router = express.Router();

router.get("/", verifyToken, async (req, res) => {
  try {
    const locations = await Location.find({})
      .populate("author")
      .sort({ order: -1 });// descending  order// match with order that we want to show/ allow drag
    res.status(200).json(hoots);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

// router.post("/", verifyToken, async (req, res) => {
//   try {
//     req.body.author = req.user._id;
//     //opt 1 to populate author data
//     const location = await Location.create(req.body);
//     location._doc.author = req.user;
//     //opt 2
//     // let location = await Location.create(req.body);
//     // location=await location.populate('author');
    
//     res.status(201).json(location);
//   } catch (err) {
//     res.status(500).json({ err: err.message });
//   }
// });

// to manage orders
router.post("/", verifyToken, async (req, res) => {
  try {
    // create new location order based on the last one 
    const maxOrder = await Location.findOne().sort({ order: -1 }).select("order");
    const newLocationOrder = maxOrder ? maxOrder.order + 1 : 0;

    const location = await Location.create({
      ...req.body,           
      author: req.user._id,  
      order: newLocationOrder
    });

    res.status(201).json(location);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

router.get("/:locationId", verifyToken, async (req, res) => {
  try {
    const location = await Location.findById(req.params.locationId).populate([
      'author',
      'comments.author',
    ]);
    res.status(200).json(location);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});


//update

router.put("/:locationId", verifyToken, async (req, res) => {
  try {
    const location = await Location.findById(req.params.locationId);
    if (!location.author.equals(req.user._id)) {
      return res.status(403).send("You're not allowed to make changes!");
    }

    // Update hoot:
    const updatedLocation = await Location.findByIdAndUpdate(
      req.params.locationId,
      req.body,
      { new: true }
    );

    updatedLocation_doc.author = req.user;

    // Issue JSON response:
    res.status(200).json(updatedLocation);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

// delete

router.delete("/:locationId", verifyToken, async (req, res) => {
  try {
    const location = await Location.findById(req.params.locationId);

    if (!location.author.equals(req.user._id)) {
      return res.status(403).send("You can't delete this entry, you're not the author!");
    }

    const deletedLocation = await Location.findByIdAndDelete(req.params.locationId);
    res.status(200).json(deletedLocation);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

//post comments


router.post("/:locationId/comments", verifyToken, async (req, res) => {
  try {
    req.body.author = req.user._id;
    const location = await Location.findById(req.params.locationId);
    location.comments.push(req.body);
    await location.save();

    const newComment = location.comments[location.comments.length - 1];

    newComment._doc.author = req.user;

    res.status(201).json(newComment);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

// update comments

router.put("/:locationId/comments/:commentId", verifyToken, async (req, res) => {
  try {
    const location= await Location.findById(req.params.locationId);
    const comment = location.comments.id(req.params.locationId);

    // ensures the current user is the author of the comment
    if (location.author.toString() !== req.user._id) {
      return res
        .status(403)
        .json({ message: "You are not authorized to change this comment, you're not the author" });
    }
    comment.text = req.body.text;
    await location.save();
    res.status(200).json({ message: "Comment updated successfully" });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

//delete comments


router.delete("/:locationId/comments/:commentId", verifyToken, async (req, res) => {
  try {
    const location = await Location.findById(req.params.locationId);
    const comment = location.comments.id(req.params.commentId);

    if (comment.author.toString() !== req.user._id) {
      return res
        .status(403)
        .json({ message: "You are not authorized to delete this comment" });
    }

    location.comments.remove({ _id: req.params.commentId });
    await location.save();
    res.status(200).json({ message: "Comment deleted successfully" });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});


module.exports = router;
