// BlockCall Signaling Server
// This connects users for video calls
const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const { ExpressPeerServer } = require('peer');

const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
});

// PeerJS Server for WebRTC connections
const peerServer = ExpressPeerServer(server, {
    debug: true,
    path: '/peerjs',
    allow_discovery: true
});

app.use('/peerjs', peerServer);

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: '✅ BlockCall Signaling Server Running',
        connections: io.engine.clientsCount,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        message: 'Server is healthy and ready for calls!'
    });
});

// Test endpoint
app.get('/test', (req, res) => {
    res.json({
        message: '🎉 Server is working!',
        activeConnections: io.engine.clientsCount
    });
});

// Store active users and rooms
const users = new Map();
const rooms = new Map();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);

    // User joins with their info
    socket.on('join', (userData) => {
        users.set(socket.id, {
            ...userData,
            socketId: socket.id,
            peerId: userData.peerId,
            connectedAt: Date.now()
        });
        console.log('👤 User joined:', userData.name || socket.id);
        
        // Send back confirmation
        socket.emit('joined', {
            socketId: socket.id,
            message: 'Successfully connected to BlockCall server'
        });
    });

    // Create meeting room
    socket.on('create-room', (roomData) => {
        const roomId = roomData.code;
        socket.join(roomId);
        
        rooms.set(roomId, {
            host: socket.id,
            participants: [socket.id],
            created: Date.now(),
            name: roomData.name || 'Untitled Meeting',
            ...roomData
        });

        socket.emit('room-created', { 
            roomId, 
            peerId: roomData.peerId,
            message: 'Room created successfully'
        });
        
        console.log('🏠 Room created:', roomId, 'by', socket.id);
    });

    // Join meeting room
    socket.on('join-room', ({ roomId, peerId, userName }) => {
        const room = rooms.get(roomId);
        
        if (!room) {
            socket.emit('room-error', { 
                message: 'Room not found',
                roomId 
            });
            console.log('❌ Room not found:', roomId);
            return;
        }

        socket.join(roomId);
        room.participants.push(socket.id);

        // Notify others in room
        socket.to(roomId).emit('user-joined', {
            socketId: socket.id,
            peerId,
            userName: userName || 'Guest'
        });

        // Send existing participants to new user
        const existingUsers = room.participants
            .filter(id => id !== socket.id)
            .map(id => users.get(id))
            .filter(Boolean);

        socket.emit('existing-users', existingUsers);
        
        console.log('👥 User joined room:', roomId, userName || socket.id);
    });

    // 1-on-1 call initiation
    socket.on('call-user', ({ to, from, offer, callType }) => {
        console.log('📞 Call request from', from, 'to', to);
        
        // Find target user by peerId, email, or wallet
        const targetUser = Array.from(users.values()).find(u => 
            u.peerId === to || u.email === to || u.wallet === to
        );

        if (targetUser) {
            io.to(targetUser.socketId).emit('incoming-call', {
                from: from,
                fromSocketId: socket.id,
                offer: offer,
                callType: callType
            });
            console.log('✅ Call forwarded to', to);
        } else {
            socket.emit('call-failed', { 
                message: 'User not found or offline',
                targetId: to
            });
            console.log('❌ User not found:', to);
        }
    });

    // Answer call
    socket.on('answer-call', ({ to, answer }) => {
        io.to(to).emit('call-answered', {
            from: socket.id,
            answer: answer
        });
        console.log('✅ Call answered');
    });

    // ICE candidate exchange
    socket.on('ice-candidate', ({ to, candidate }) => {
        io.to(to).emit('ice-candidate', {
            from: socket.id,
            candidate: candidate
        });
    });

    // Chat message
    socket.on('chat-message', ({ roomId, message, userName }) => {
        const timestamp = Date.now();
        socket.to(roomId).emit('chat-message', {
            from: userName || 'Anonymous',
            fromSocketId: socket.id,
            message: message,
            timestamp: timestamp
        });
        console.log('💬 Chat message in room', roomId);
    });

    // Screen share start
    socket.on('screen-share-start', ({ roomId, peerId }) => {
        socket.to(roomId).emit('screen-share-started', {
            from: socket.id,
            peerId: peerId
        });
        console.log('🖥️ Screen share started in room:', roomId);
    });

    // Screen share stop
    socket.on('screen-share-stop', ({ roomId }) => {
        socket.to(roomId).emit('screen-share-stopped', {
            from: socket.id
        });
        console.log('🖥️ Screen share stopped in room:', roomId);
    });

    // Leave room
    socket.on('leave-room', (roomId) => {
        socket.leave(roomId);
        const room = rooms.get(roomId);
        
        if (room) {
            room.participants = room.participants.filter(id => id !== socket.id);
            socket.to(roomId).emit('user-left', { 
                socketId: socket.id 
            });
            
            // Delete room if empty
            if (room.participants.length === 0) {
                rooms.delete(roomId);
                console.log('🗑️ Room deleted (empty):', roomId);
            }
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log('❌ User disconnected:', socket.id);
        
        // Remove from users
        const user = users.get(socket.id);
        users.delete(socket.id);
        
        // Remove from all rooms
        rooms.forEach((room, roomId) => {
            if (room.participants.includes(socket.id)) {
                room.participants = room.participants.filter(id => id !== socket.id);
                socket.to(roomId).emit('user-left', { 
                    socketId: socket.id,
                    userName: user?.name || 'Guest'
                });
                
                // Delete room if empty
                if (room.participants.length === 0) {
                    rooms.delete(roomId);
                    console.log('🗑️ Room deleted (empty):', roomId);
                }
            }
        });
    });

    // Heartbeat to keep connection alive
    socket.on('ping', () => {
        socket.emit('pong');
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════════════╗
    ║   🚀 BlockCall Signaling Server              ║
    ║   ✅ Running on port ${PORT.toString().padEnd(24)}║
    ║   🌐 Ready for video call connections        ║
    ║   ⛓️  Blockchain-verified calling enabled    ║
    ╚══════════════════════════════════════════════╝
    `);
});

// Error handling
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Rejection:', err);
});
