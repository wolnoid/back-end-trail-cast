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

const logSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: true
    },
    day: {
      type: Date,
      required: true,
      default: Date.now 
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
    trim: true,
    required: true,
  },
  longitude: {
    type: Number,
    required: true,
  },
  latitude: {
    type: Number,
    required: true,
  },
  description:{
    type:String,
    trim: true,
    default: '',
  },
  author:{
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    required: true,
  },
  comments: [commentSchema],
  logs: [logSchema],
  },
  {timestamps:true}
);

locationSchema.index({ author: 1, longitude: 1, latitude: 1 }, { unique: true });

const Location = mongoose.model('Location', locationSchema);

module.exports = Location;