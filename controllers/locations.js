const express = require("express");
const verifyToken = require("../middleware/verify-token.js");
const Location = require("../models/location.js");
const router = express.Router();

const API_KEY = process.env.API_KEY;


router.get("/", async (req, res) => {
  try {
    const locations = await Location.find({})
      .populate("author")
      .sort({ order: -1 });// descending  order// match with order that we want to show/ allow drag
    res.status(200).json(locations);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

//searching locations

router.get('/places', async (req, res) => {
  try {
    const search = req.query.search;
    if (!search) {
      return res.status(400).json({ err: "Search query is required" });
    };

    const response = await fetch(
      `https://api.geoapify.com/v1/geocode/search?text=${search}&apiKey=${API_KEY}`
    );
    const data = await response.json();

    if (!data.features?.length) {
      return res.status(404).json({ err: "No places found" });
    }

    const places = data.features.map(feature => ({
      name: feature.properties.name,
      place_id: feature.properties.place_id
    }));

    res.json({ places });
  } catch (err) {
    console.error(err);
    res.status(500).json({ err: err.message });
  }
});

router.get('/place/:placeId/weather', async (req, res) => {
  try {
    const placeId = req.params.placeId;

    const categoriesResponse = await fetch(
      `https://api.geoapify.com/v2/places?categories=ski,natural&filter=place:${placeId}&limit=5&apiKey=${API_KEY}`
    );
    const categoriesData = await categoriesResponse.json();
    const feature = categoriesData.features?.[0];

    if (!feature) {
      throw new Error("No location found");
    }

    const { lon, lat, name } = feature.properties;

    const pointsResponse = await fetch(`https://api.weather.gov/points/${lat},${lon}`);
    const pointsData = await pointsResponse.json();
    const forecastUrl = pointsData.properties.forecast;

    const forecastResponse = await fetch(forecastUrl);
    const forecastData = await forecastResponse.json();
    const weather = forecastData.properties.periods.slice(0, 5);

    res.json({
      location: {
        name,
        forecast: weather
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ err: err.message });
  }
});

// posting locations managing orders
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

//post logs

router.post("/:locationId/logs", verifyToken, async (req, res) => {
  try {
    req.body.author = req.user._id;
    const location = await Location.findById(req.params.locationId);
    location.logs.push(req.body);
    await location.save();

    const newLog = location.logs[location.logs.length - 1];

    newLog._doc.author = req.user;

    res.status(201).json(newLog);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

// update comments

router.put("/:locationId/logs/:logId", verifyToken, async (req, res) => {
  try {
    const location= await Location.findById(req.params.locationId);
    const log = location.comments.id(req.params.logId);

    // ensures the current user is the author of the comment
    if (location.author.toString() !== req.user._id) {
      return res
        .status(403)
        .json({ message: "You are not authorized to change this activity, you're not the author" });
    }
    log.text = req.body.text;
    await location.save();
    res.status(200).json({ message: "Activity updated successfully" });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

//delete comments

router.delete("/:locationId/logs/:logId", verifyToken, async (req, res) => {
  try {
    const location = await Location.findById(req.params.locationId);
    const log = location.logs.id(req.params.logId);

    if (log.author.toString() !== req.user._id) {
      return res
        .status(403)
        .json({ message: "You are not authorized to delete this activity" });
    }

    location.logs.remove({ _id: req.params.logId });
    await location.save();
    res.status(200).json({ message: "Activity deleted successfully" });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

module.exports = router;


// router.get('/search', async(req,res)=>{

//   try{
//     const placeResponse= await fetch(`https://api.geoapify.com/v1/geocode/search?text=${req.query.search}&apiKey=${API_KEY}`);
//     const PlaceData= await placeResponse.json();
//     const placeId = PlaceData.features[0].properties.place_id;

//     const categoriesResponse=await fetch (`https://api.geoapify.com/v2/places?categories=ski,natural&filter=place:${placeId}&limit=10&apiKey=${API_KEY}`)
//     const categoriesData=await categoriesResponse.json();
//     const feature = categoriesData.features?.[0];

//       if (!feature) {
//         throw new Error("No location found");
//       };

//     const { lon, lat, name } = feature.properties;  

//     const pointsResponse=await fetch (`https://api.weather.gov/points/${lat},${lon}`);
//     const pointsData=await pointsResponse.json();
//     const forecastUrl= pointsData.properties.forecast;

//     const forecastResponse= await fetch(forecastUrl);
//     const forecastData= await forecastResponse.json();
//     const weather=forecastData.properties.periods;

//     res.json({
//       location:{
//         name:name,
//         forecast: weather
//       }
//     })
    
//   }catch (err) {
//     res.status(500).json({ err: err.message });
//   }
// });
