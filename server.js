require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const http      = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');

const authRoutes    = require('./routes/auth');
const userRoutes    = require('./routes/users');
const bookingRoutes = require('./routes/bookings');
const driverRoutes  = require('./routes/drivers');
const routeRoutes   = require('./routes/routes');
const statsRoutes   = require('./routes/stats');
const { tgChatMessage, tgVisitorOnline, initBot } = require('./services/telegram');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth',     authRoutes);
app.use('/api/users',    userRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/drivers',  driverRoutes);
app.use('/api/routes',   routeRoutes);
app.use('/api/stats',    statsRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

/* ══════════════════════════════════════════
   CANLI DESTEK — Socket.io
══════════════════════════════════════════ */

// Aktif ziyaretçiler: sessionId → visitor data
const visitors  = new Map();
// Admin socket id'leri
const adminSockets = new Set();

// Telegram bot komutlarını başlat
initBot(() => Array.from(visitors.values()), io);

function broadcastVisitors() {
  const list = Array.from(visitors.values()).map(v => ({
    sessionId:   v.sessionId,
    name:        v.name,
    phone:       v.phone || '',
    page:        v.page,
    pageTitle:   v.pageTitle,
    device:      v.device,
    startTime:   v.startTime,
    lastSeen:    v.lastSeen,
    unread:      v.messages.filter(m => m.from === 'visitor' && !m.read).length,
    online:      v.online,
    totalPages:  v.pageHistory.length,
    pageHistory: v.pageHistory,
    activity:    v.activity,
    messages:    v.messages,
  }));
  io.to('admins').emit('visitors:update', list);
}

io.on('connection', (socket) => {

  /* ── Admin bağlandı ── */
  socket.on('admin:join', () => {
    socket.join('admins');
    adminSockets.add(socket.id);
    broadcastVisitors();
  });

  /* ── Admin ziyaretçiye mesaj gönderdi ── */
  socket.on('admin:message', ({ sessionId, text }) => {
    const v = visitors.get(sessionId);
    if (!v) return;
    const msg = { from: 'admin', senderName: 'Yönetici', text, time: new Date().toISOString(), id: Date.now() };
    v.messages.push(msg);
    // Ziyaretçiye gönder
    if (v.socketId) io.to(v.socketId).emit('chat:message', msg);
    // Diğer admin sekmelerine senkronize et
    io.to('admins').emit('chat:sync', { sessionId, message: msg });
    broadcastVisitors();
  });

  /* ── Admin yazıyor ── */
  socket.on('admin:typing', ({ sessionId, typing }) => {
    const v = visitors.get(sessionId);
    if (v && v.socketId) io.to(v.socketId).emit('chat:admin_typing', typing);
  });

  /* ── Admin mesajları okudu ── */
  socket.on('admin:read', ({ sessionId }) => {
    const v = visitors.get(sessionId);
    if (!v) return;
    v.messages.forEach(m => { if (m.from === 'visitor') m.read = true; });
    broadcastVisitors();
  });

  /* ── Ziyaretçi bağlandı ── */
  socket.on('visitor:connect', ({ sessionId, name, phone, page, pageTitle, device }) => {
    const isNew = !visitors.has(sessionId);
    let v = visitors.get(sessionId);
    const now = new Date().toISOString();
    if (!v) {
      v = {
        sessionId,
        name:          name || 'Ziyaretçi',
        phone:         phone || '',
        page,
        pageTitle,
        device:        device || 'Bilinmiyor',
        startTime:     now,
        lastSeen:      now,
        messages:      [],
        online:        true,
        socketId:      socket.id,
        activity:      [],
        pageHistory:   [],          // { page, pageTitle, enteredAt, duration }
        currentPageStart: now,      // ne zaman bu sayfaya girdi
      };
      // İlk sayfayı kaydet
      if (page) v.pageHistory.push({ page, pageTitle, enteredAt: now, duration: null });
      visitors.set(sessionId, v);
    } else {
      v.socketId = socket.id;
      v.online   = true;
      v.lastSeen = now;
      v.currentPageStart = now;
      if (name && name !== 'Ziyaretçi') v.name = name;
      if (phone) v.phone = phone;
    }
    socket.sessionId = sessionId;
    // Admin'e bildir
    broadcastVisitors();
    io.to('admins').emit('visitor:joined', { sessionId: v.sessionId, name: v.name, page: v.page });
    // Telegram — sadece yeni ziyaretçileri bildir
    if (isNew) {
      tgVisitorOnline(v.name, v.page || '/').catch(() => {});
    }
    // Varsa önceki mesaj geçmişini gönder
    if (v.messages.length > 0) {
      socket.emit('chat:history', v.messages);
    }
  });

  /* ── Ziyaretçi sayfa değiştirdi ── */
  socket.on('visitor:page', ({ sessionId, page, pageTitle }) => {
    const v = visitors.get(sessionId);
    if (!v) return;
    const now = new Date().toISOString();

    // Önceki sayfada geçirilen süreyi hesapla
    let duration = null;
    if (v.currentPageStart) {
      duration = Math.round((new Date(now) - new Date(v.currentPageStart)) / 1000);
      // Geçmiş kayıtta son girişin süresini güncelle
      const last = v.pageHistory[v.pageHistory.length - 1];
      if (last && last.duration === null) last.duration = duration;
    }

    v.page             = page;
    v.pageTitle        = pageTitle;
    v.lastSeen         = now;
    v.currentPageStart = now;

    // Yeni sayfayı geçmişe ekle
    v.pageHistory.push({ page, pageTitle, enteredAt: now, duration: null });
    if (v.pageHistory.length > 100) v.pageHistory.shift();

    const entry = { type: 'page', page, pageTitle, time: now, prevDuration: duration };
    v.activity.push(entry);
    if (v.activity.length > 100) v.activity.shift();

    broadcastVisitors();
    io.to('admins').emit('visitor:activity', { sessionId, ...entry });
  });

  /* ── Ziyaretçi aktivite (form doldurma, buton tıklama vb.) ── */
  socket.on('visitor:action', ({ sessionId, action, detail }) => {
    const v = visitors.get(sessionId);
    if (!v) return;
    v.lastSeen = new Date().toISOString();
    const entry = { type: 'action', action, detail, time: new Date().toISOString() };
    v.activity.push(entry);
    if (v.activity.length > 50) v.activity.shift();
    io.to('admins').emit('visitor:activity', { sessionId, ...entry });
  });

  /* ── Ziyaretçi mesaj gönderdi ── */
  socket.on('visitor:message', ({ sessionId, text, name, phone }) => {
    let v = visitors.get(sessionId);
    if (!v) return;
    if (name && name !== 'Ziyaretçi') v.name = name;
    if (phone) v.phone = phone;
    const msg = { from: 'visitor', senderName: v.name, text, time: new Date().toISOString(), id: Date.now(), read: false };
    v.messages.push(msg);
    v.lastSeen = new Date().toISOString();
    io.to('admins').emit('chat:sync', { sessionId, message: msg });
    broadcastVisitors();
    // Telegram bildirimi — admin paneli açık değilse haberdar et
    tgChatMessage(v.name, v.phone, text, sessionId).catch(() => {});
    // Onay ziyaretçiye
    socket.emit('chat:delivered', { id: msg.id });
  });

  /* ── Ziyaretçi yazıyor ── */
  socket.on('visitor:typing', ({ sessionId, typing }) => {
    io.to('admins').emit('chat:visitor_typing', { sessionId, typing });
  });

  /* ── Bağlantı kesildi ── */
  socket.on('disconnect', () => {
    adminSockets.delete(socket.id);
    const sid = socket.sessionId;
    if (sid && visitors.has(sid)) {
      visitors.get(sid).online  = false;
      visitors.get(sid).lastSeen = new Date().toISOString();
      broadcastVisitors();
    }
  });
});

// 24 saatten uzun süredir offline olan ziyaretçileri temizle (geçmiş korunsun)
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [sid, v] of visitors.entries()) {
    if (!v.online && new Date(v.lastSeen).getTime() < cutoff) visitors.delete(sid);
  }
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ Güliz Transfer API çalışıyor → http://localhost:${PORT}`);
  console.log(`🌐 Müşteri sitesi          → http://localhost:${PORT}/`);
  console.log(`🔧 Admin paneli            → http://localhost:${PORT}/admin.html`);
});
