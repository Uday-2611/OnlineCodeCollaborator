require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Room = require('./models/Room');

// Helper function for password hashing
const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
};

// Helper function for password verification
const verifyPassword = (password, hashedPassword) => {
  const [salt, storedHash] = hashedPassword.split(':');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return storedHash === hash;
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 5000,
  cookie: false
});

// Connect to MongoDB Atlas
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is not defined in .env file');
  process.exit(1);
}

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  retryWrites: true,
  w: 'majority'
})
.then(() => {
  console.log('✅ Connected to MongoDB Atlas');
})
.catch((err) => {
  console.error('❌ MongoDB Atlas connection error:', err);
  process.exit(1); // Exit if unable to connect to database
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/rooms', async (req, res) => {
  try {
    const { roomName, username, password } = req.body;
    
    // Validate inputs
    if (!roomName || !username || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Generate hashed password
    const hashedPassword = hashPassword(password);
    
    // Create new room with server-generated ID
    const room = new Room({
      roomId: await Room.generateRoomId(),
      name: roomName.trim().substring(0, 50),
      password: hashedPassword,
      owner: username.trim().substring(0, 30),
      activeUsers: [username.trim()]
    });

    await room.save();
    
    res.json({ 
      success: true,
      roomId: room.roomId,
      redirect: `/room/${room.roomId}`
    });
  } catch (err) {
    console.error('Room creation error:', err);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/create-room', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create-room.html'));
});

app.get('/join-room', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join-room.html'));
});

app.get('/room/:roomId', async (req, res) => {
  const { roomId } = req.params;
  console.log(`Checking room existence for roomId: ${roomId}`);

  if (!/^\d{6}$/.test(roomId)) {
    console.log(`Invalid roomId format: ${roomId}`);
    return res.redirect('/join-room');
  }

  const room = await Room.findOne({ roomId });
  if (!room) {
    console.log(`Room not found for roomId: ${roomId}`);
    return res.redirect('/join-room?error=Room not found');
  }

  console.log(`Room found: ${roomId}`);
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// Socket.IO connection handling
io.on('connection', socket => {
  console.log(`New connection: ${socket.id}`);

  socket.on('join-room', async (roomId, username, password) => {
    try {
      // Validate inputs
      if (!username || !roomId || !password) {
        throw new Error('All fields are required');
      }
  
      // Find room
      const room = await Room.findOne({ roomId });
      if (!room) {
        throw new Error('Room not found');
      }
  
      // Verify password
      if (!verifyPassword(password, room.password)) {
        throw new Error('Incorrect password');
      }

      // Add user to room
      if (!room.activeUsers.includes(username)) {
        room.activeUsers.push(username);
        await room.save();
      }

      // Store user info in socket
      socket.roomId = roomId;
      socket.username = username;

      // Join socket.io room
      socket.join(roomId);

      // Send room info to user
      socket.emit('room-info', {
        roomId: room.roomId,
        roomName: room.name,
        owner: room.owner
      });

      // Send current user list
      io.to(roomId).emit('user-list', room.activeUsers);

      // Notify others
      socket.to(roomId).emit('user-joined', username);

      // Send current code
      socket.emit('code-update', room.code || '');

    } catch (error) {
      console.error('Join room error:', error.message);
      socket.emit('room-denied', error.message);
    }
  });

  // Handle code changes
  socket.on('code-change', async (code) => {
    const { roomId } = socket;
    if (!roomId) return;

    try {
      // Update code in database
      await Room.findOneAndUpdate({ roomId }, { 
        code,
        lastActive: new Date()
      });

      // Broadcast to other users in room
      socket.to(roomId).emit('code-update', code);
    } catch (error) {
      console.error('Code update error:', error);
    }
  });

  // Handle chat messages
  socket.on('chat-message', (message) => {
    const { roomId, username } = socket;
    if (!roomId || !username || !message.trim()) return;

    const messageData = {
      sender: username,
      message: message.trim(),
      time: Date.now()
    };

    // Broadcast to all users in the room (including sender)
    io.to(roomId).emit('chat-message', messageData);
  });

  socket.on('disconnect', async () => {
    const { roomId, username } = socket;
    if (!roomId || !username) return;

    try {
      const room = await Room.findOne({ roomId });
      if (!room) return;

      // Remove user from active users
      room.activeUsers = room.activeUsers.filter(u => u !== username);
      await room.save();
      
      console.log(`${username} left room ${roomId}`);

      // Notify remaining users
      io.to(roomId).emit('user-list', room.activeUsers);
      io.to(roomId).emit('user-left', username);

      // If room is empty, update lastActive to trigger TTL
      if (room.activeUsers.length === 0) {
        await Room.findOneAndUpdate(
          { roomId },
          { lastActive: new Date() }
        );
      }
    } catch (error) {
      console.error('Disconnect error:', error);
    }
  });

});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});