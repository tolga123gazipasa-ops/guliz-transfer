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
const db = require('./models/db');

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
    db.query(
      `INSERT INTO chat_messages (session_id, from_type, sender_name, text, read) VALUES ($1,'admin','Yönetici',$2,true)`,
      [sessionId, text]
    ).catch(() => {});
    if (v.socketId) io.to(v.socketId).emit('chat:message', msg);
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
  socket.on('visitor:connect', async ({ sessionId, name, phone, page, pageTitle, device }) => {
    const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim()
               || socket.handshake.address || '';
    const isNew = !visitors.has(sessionId);
    let v = visitors.get(sessionId);
    const now = new Date().toISOString();
    if (!v) {
      v = {
        sessionId,
        name:          name || 'Ziyaretçi',
        phone:         phone || '',
        ip,
        page,
        pageTitle,
        device:        device || 'Bilinmiyor',
        startTime:     now,
        lastSeen:      now,
        messages:      [],
        online:        true,
        socketId:      socket.id,
        activity:      [],
        pageHistory:   [],
        currentPageStart: now,
      };
      if (page) v.pageHistory.push({ page, pageTitle, enteredAt: now, duration: null });
      visitors.set(sessionId, v);
    } else {
      v.socketId = socket.id;
      v.online   = true;
      v.lastSeen = now;
      v.currentPageStart = now;
      if (name && name !== 'Ziyaretçi') v.name = name;
      if (phone) v.phone = phone;
      if (ip) v.ip = ip;
    }
    socket.sessionId = sessionId;

    // DB'ye kaydet / güncelle
    db.query(
      `INSERT INTO chat_sessions (session_id, name, phone, ip, device, first_page, last_page, online, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         name=COALESCE(NULLIF($2,'Ziyaretçi'), chat_sessions.name),
         phone=COALESCE(NULLIF($3,''), chat_sessions.phone),
         ip=$4, device=$5, last_page=$7, online=true, last_seen=NOW()`,
      [sessionId, v.name, v.phone || null, ip || null, device || null, page || null, page || null]
    ).catch(() => {});

    // DB'den mesaj geçmişini yükle (memory boşsa)
    if (v.messages.length === 0) {
      const { rows } = await db.query(
        `SELECT from_type, sender_name, text, read, created_at FROM chat_messages
         WHERE session_id=$1 ORDER BY created_at ASC LIMIT 100`, [sessionId]
      ).catch(() => ({ rows: [] }));
      if (rows.length > 0) {
        v.messages = rows.map(r => ({
          from: r.from_type, senderName: r.sender_name,
          text: r.text, read: r.read,
          time: r.created_at, id: r.created_at
        }));
      }
    }

    // Admin'e bildir
    broadcastVisitors();
    io.to('admins').emit('visitor:joined', { sessionId: v.sessionId, name: v.name, page: v.page });
    // Telegram — sadece yeni ziyaretçileri bildir
    if (isNew) {
      tgVisitorOnline(v.name, v.page || '/').catch(() => {});
    }
    // Mesaj geçmişini gönder
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
    db.query(
      `INSERT INTO chat_messages (session_id, from_type, sender_name, text, read) VALUES ($1,'visitor',$2,$3,false)`,
      [sessionId, v.name, text]
    ).catch(() => {});
    db.query(`UPDATE chat_sessions SET name=$2, phone=$3, last_seen=NOW() WHERE session_id=$1`,
      [sessionId, v.name, v.phone || null]
    ).catch(() => {});
    io.to('admins').emit('chat:sync', { sessionId, message: msg });
    broadcastVisitors();
    tgChatMessage(v.name, v.phone, text, sessionId).catch(() => {});
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

// Yeni tabloları otomatik oluştur
db.query(`
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id SERIAL PRIMARY KEY, session_id VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(100) DEFAULT 'Ziyaretçi', phone VARCHAR(20), ip VARCHAR(50),
    device VARCHAR(150), first_page VARCHAR(255), last_page VARCHAR(255),
    online BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY, session_id VARCHAR(100) NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
    from_type VARCHAR(10) NOT NULL, sender_name VARCHAR(100), text TEXT NOT NULL,
    read BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
  CREATE TABLE IF NOT EXISTS telegram_mappings (
    telegram_msg_id BIGINT PRIMARY KEY, session_id VARCHAR(100) NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
  );
`).catch(e => console.error('Tablo oluşturma hatası:', e.message));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ Güliz Transfer API çalışıyor → http://localhost:${PORT}`);
  console.log(`🌐 Müşteri sitesi          → http://localhost:${PORT}/`);
  console.log(`🔧 Admin paneli            → http://localhost:${PORT}/admin.html`);
});
