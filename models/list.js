const mongoose = require('mongoose');

const listLocationSchema = new mongoose.Schema(
  {
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Location',
      required: true
    },
    order: {
      type: Number,
      default: 0
    },
    addedAt: {
      type: Date,
      default: Date.now
    },
  },
  { _id: false }
);

const commentSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: true
    },
   owner: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User' 
    }
  },
  { timestamps: true }
);

const listSchema = new mongoose.Schema(
  {
    name: { 
      type: String,
      required: true,
      trim: true
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User', required: true
    },
    description: {
      type: String,
      trim: true,
      default: ''
    },
    locations: {
      type: [listLocationSchema],
      default: []
    },
    comments: {
      type: [commentSchema],
      default:[]
    },
  }, 
  { timestamps: true }
);

listSchema.index({ owner: 1, name: 1 }, { unique: true });

// prevents duplicates of the same location inside a single list
listSchema.index({ _id: 1, 'locations.location': 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('List', listSchema);
