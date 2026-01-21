const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: true
    },
    author: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User' }
  },
  { timestamps: true }
);

const locationSchema = mongoose.Schema(
  {
    //to track order
  order: { 
    type: Number, 
    default: 0 
  },
  name: {
    type: String,
    required: true,
  },
  description:{
    type:String,
    required:true,
  },
  day: {
    type: String,
    // required: true,
  },
  temperature: {
    type: Number,
    // required: true,
  },
  temperatureUnit: {
    type: String,
    required: true,
    enum:['F', 'C']
  },
  probabilityOfPrecipitation: {
    type: Number,
    required: true,
    min: 0,
    max: 100
  },
  shortForecast: {
    type: String,
    required: true,
  },
  detailedForecast: {
    type: String,
    required: true,
  },
  author:{
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User'
  },
  comments: [commentSchema],
  },
  {timestamps:true}
);

const Location = mongoose.model('Location', locationSchema);

module.exports = Location;