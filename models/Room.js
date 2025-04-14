const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
    unique: true,
    validate: {
      validator: function(v) {
        return /^\d{6}$/.test(v);
      },
      message: props => `${props.value} is not a valid 6-digit room ID!`
    }
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 50
  },
  password: {
    type: String,
    required: true
  },
  owner: {
    type: String,
    required: true,
    trim: true
  },
  lastActive: {
    type: Date,
    default: Date.now,
    expires: 86400 // Document will be deleted after 24 hours of inactivity
  },
  activeUsers: [{
    type: String,
    trim: true
  }],
  code: {
    type: String,
    default: ''
  },
  fileName: {
    type: String,
    default: 'untitled.txt'
  },
  syntaxType: {
    type: String,
    default: 'text'
  }
});

// Update lastActive when users array changes
roomSchema.pre('save', function(next) {
  if (this.isModified('activeUsers')) {
    this.lastActive = new Date();
  }
  next();
});

// Add a method to generate unique 6-digit room IDs
roomSchema.statics.generateRoomId = async function() {
  let roomId;
  let isUnique = false;

  while (!isUnique) {
    roomId = Math.floor(100000 + Math.random() * 900000).toString();
    const existingRoom = await this.findOne({ roomId });
    if (!existingRoom) {
      isUnique = true;
    }
  }

  return roomId;
};

module.exports = mongoose.model('Room', roomSchema);