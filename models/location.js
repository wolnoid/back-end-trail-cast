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
    required: true,
  },
  description:{
    type:String,
    required:true,
  },
  author:{
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User'
  },
  comments: [commentSchema],
  logs: [logSchema],
  },
  {timestamps:true}
);

const Location = mongoose.model('Location', locationSchema);

module.exports = Location;