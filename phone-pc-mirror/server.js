const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: process.env.ALLOWED_ORIGINS?.split(',') || "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e8 // 100MB
});

// إعدادات الأمان
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(compression({
    level: 6,
    threshold: 1024
}));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// تحديد معدل الطلبات
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: '太多请求، يرجى المحاولة لاحقاً'
});
app.use('/api/', limiter);

// إدارة الجلسات المتقدمة
class SessionManager {
    constructor() {
        this.sessions = new Map();
        this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    }

    createSession(sessionId, socket, role, userAgent) {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, {
                id: sessionId,
                desktop: null,
                phone: null,
                desktopSocket: null,
                phoneSocket: null,
                connected: false,
                createdAt: Date.now(),
                lastActivity: Date.now(),
                stats: {
                    framesTransferred: 0,
                    commandsSent: 0,
                    bytesTransferred: 0
                },
                metadata: {
                    desktopUserAgent: null,
                    phoneUserAgent: null,
                    desktopIP: null,
                    phoneIP: null
                }
            });
        }

        const session = this.sessions.get(sessionId);
        session.lastActivity = Date.now();

        if (role === 'desktop') {
            session.desktop = socket.id;
            session.desktopSocket = socket;
            session.metadata.desktopUserAgent = userAgent;
            session.metadata.desktopIP = socket.handshake.address;
        } else if (role === 'phone') {
            session.phone = socket.id;
            session.phoneSocket = socket;
            session.metadata.phoneUserAgent = userAgent;
            session.metadata.phoneIP = socket.handshake.address;
        }

        if (session.desktop && session.phone && !session.connected) {
            session.connected = true;
            this.notifyConnection(sessionId);
        }

        return session;
    }

    notifyConnection(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session && session.desktopSocket && session.phoneSocket) {
            io.to(session.desktop).emit('phone-connected', {
                message: 'تم اتصال الهاتف بنجاح',
                timestamp: Date.now(),
                stats: session.stats
            });
            io.to(session.phone).emit('desktop-connected', {
                message: 'تم اتصال الكمبيوتر بنجاح',
                timestamp: Date.now()
            });
        }
    }

    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }

    updateStats(sessionId, type, size = 0) {
        const session = this.sessions.get(sessionId);
        if (session) {
            if (type === 'frame') {
                session.stats.framesTransferred++;
                session.stats.bytesTransferred += size;
            } else if (type === 'command') {
                session.stats.commandsSent++;
            }
            session.lastActivity = Date.now();
        }
    }

    disconnectDevice(socketId, role) {
        for (const [sessionId, session] of this.sessions) {
            if ((role === 'desktop' && session.desktop === socketId) ||
                (role === 'phone' && session.phone === socketId)) {
                
                if (role === 'desktop') {
                    session.desktop = null;
                    session.desktopSocket = null;
                } else {
                    session.phone = null;
                    session.phoneSocket = null;
                }
                session.connected = false;
                
                // إعلام الطرف الآخر
                if (session.desktopSocket) {
                    io.to(session.desktop).emit('phone-disconnected', {
                        message: 'انقطع اتصال الهاتف'
                    });
                }
                if (session.phoneSocket) {
                    io.to(session.phone).emit('desktop-disconnected', {
                        message: 'انقطع اتصال الكمبيوتر'
                    });
                }
                break;
            }
        }
    }

    cleanup() {
        const now = Date.now();
        for (const [sessionId, session] of this.sessions) {
            // حذف الجلسات غير النشطة لأكثر من 30 دقيقة
            if (now - session.lastActivity > 30 * 60 * 1000) {
                this.sessions.delete(sessionId);
                console.log(`تم حذف الجلسة غير النشطة: ${sessionId}`);
            }
        }
    }

    getStats() {
        return {
            totalSessions: this.sessions.size,
            activeConnections: Array.from(this.sessions.values()).filter(s => s.connected).length,
            totalFrames: Array.from(this.sessions.values()).reduce((sum, s) => sum + s.stats.framesTransferred, 0),
            totalCommands: Array.from(this.sessions.values()).reduce((sum, s) => sum + s.stats.commandsSent, 0)
        };
    }
}

const sessionManager = new SessionManager();

// Socket.IO الاتصالات
io.use((socket, next) => {
    const role = socket.handshake.query.role;
    const sessionId = socket.handshake.query.sessionId;
    
    if (!role || !sessionId) {
        return next(new Error('Missing required parameters'));
    }
    
    socket.role = role;
    socket.sessionId = sessionId;
    next();
});

io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}, Role: ${socket.role}, Session: ${socket.sessionId}`);
    
    const userAgent = socket.handshake.headers['user-agent'];
    sessionManager.createSession(socket.sessionId, socket, socket.role, userAgent);
    
    // معالجة إطارات الشاشة من الهاتف
    socket.on('screen-frame', async (data) => {
        if (socket.role === 'phone') {
            const session = sessionManager.getSession(socket.sessionId);
            if (session && session.desktopSocket) {
                // تحسين الصورة قبل الإرسال
                try {
                    let imageData = data.image;
                    if (imageData && imageData.startsWith('data:image')) {
                        const base64Data = imageData.split(',')[1];
                        const buffer = Buffer.from(base64Data, 'base64');
                        
                        // ضغط الصورة
                        const optimizedBuffer = await sharp(buffer)
                            .resize(800, null, { withoutEnlargement: true })
                            .jpeg({ quality: 70, progressive: true })
                            .toBuffer();
                        
                        const optimizedImage = `data:image/jpeg;base64,${optimizedBuffer.toString('base64')}`;
                        sessionManager.updateStats(socket.sessionId, 'frame', optimizedBuffer.length);
                        io.to(session.desktop).emit('screen-frame', { 
                            image: optimizedImage,
                            timestamp: Date.now()
                        });
                    } else {
                        sessionManager.updateStats(socket.sessionId, 'frame', 0);
                        io.to(session.desktop).emit('screen-frame', data);
                    }
                } catch (error) {
                    console.error('Error processing image:', error);
                    io.to(session.desktop).emit('screen-frame', data);
                }
            }
        }
    });
    
    // معالجة أوامر التحكم من الكمبيوتر
    socket.on('control-command', (data) => {
        if (socket.role === 'desktop') {
            const session = sessionManager.getSession(socket.sessionId);
            if (session && session.phoneSocket) {
                sessionManager.updateStats(socket.sessionId, 'command');
                io.to(session.phone).emit('control-command', {
                    action: data.action,
                    value: data.value,
                    timestamp: Date.now()
                });
            }
        }
    });
    
    // معالجة فصل الاتصال
    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}, Role: ${socket.role}`);
        sessionManager.disconnectDevice(socket.id, socket.role);
    });
});

// API endpoints
app.get('/api/stats', (req, res) => {
    res.json(sessionManager.getStats());
});

app.get('/api/generate-qr/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const url = `${req.protocol}://${req.get('host')}/phone.html?session=${sessionId}`;
    try {
        const qrCode = await QRCode.toDataURL(url, { width: 300, margin: 2 });
        res.json({ qrCode, url });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

// الصفحة الرئيسية
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/phone.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'phone.html'));
});

// معالجة الأخطاء
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'حدث خطأ في الخادم' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    🚀 الخادم يعمل على المنفذ: ${PORT}
    📱 رابط الكمبيوتر: http://localhost:${PORT}
    📱 رابط الهاتف: http://localhost:${PORT}/phone.html
    ✨ النظام جاهز للاستخدام
    `);
});

// معالجة إغلاق الخادم
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});
