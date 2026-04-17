require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const fs           = require('fs');
const http         = require('http');
const { Server }   = require('socket.io');
const rateLimit    = require('express-rate-limit');
const multer       = require('multer');
const helmet       = require('helmet');
const compression  = require('compression');

/* ── GeoIP yardımcısı ── */
async function geoIP(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return { country: null, city: null };
  }
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=country,city,isp&lang=tr`);
    if (!res.ok) return { country: null, city: null };
    const data = await res.json();
    return { country: data.country || null, city: data.city || null };
  } catch {
    return { country: null, city: null };
  }
}

const authRoutes    = require('./routes/auth');
const userRoutes    = require('./routes/users');
const bookingRoutes = require('./routes/bookings');
const driverRoutes  = require('./routes/drivers');
const routeRoutes   = require('./routes/routes');
const statsRoutes   = require('./routes/stats');
const kurumRoutes    = require('./routes/kurumlar');
const ihalelerRoutes = require('./routes/ihaleler');
const insaatRoutes   = require('./routes/insaat');
const takipRoutes    = require('./routes/takip');
const araclarRoutes  = require('./routes/araclar');
const { tgChatMessage, tgVisitorOnline, initBot } = require('./services/telegram');
const db = require('./models/db');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : true }
});

app.set('trust proxy', 1);
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: false, // inline script'ler var (admin.html), CSP ayrıca ayarlanabilir
  crossOriginEmbedderPolicy: false,
}));

/* ── www → non-www yönlendirmesi (SEO: tek canonical domain) ── */
app.use((req, res, next) => {
  if (req.hostname && req.hostname.startsWith('www.')) {
    const nonWww = req.hostname.slice(4);
    return res.redirect(301, `https://${nonWww}${req.originalUrl}`);
  }
  next();
});

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3001'];
app.use(cors({
  origin: (origin, cb) => cb(null, true), // tüm origin'e izin ver ama credentials'sız
  credentials: false
}));
app.use(express.json({ limit: '2mb' }));

// Login için sıkı rate limit
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true });
app.use('/api/auth/login', authLimiter);
app.use('/api/kurumlar/login', authLimiter);

app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));
app.use(express.static(path.join(__dirname, 'public')));

/* ── CV Upload (multer) ── */
const CV_DIR = path.join(__dirname, 'uploads', 'cv');
if (!fs.existsSync(CV_DIR)) fs.mkdirSync(CV_DIR, { recursive: true });
const cvStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CV_DIR),
  filename: (req, file, cb) => {
    const ts  = Date.now();
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `cv_${ts}${ext}`);
  }
});
const cvUpload = multer({
  storage: cvStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Yalnızca PDF dosyası yükleyebilirsiniz.'));
  }
});

app.use('/api/auth',     authRoutes);
app.use('/api/users',    userRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/drivers',  driverRoutes);
app.use('/api/routes',   routeRoutes);
app.use('/api/stats',    statsRoutes);
app.use('/api/kurumlar', kurumRoutes);
app.use('/api/ihaleler', ihalelerRoutes);
app.use('/api/insaat',   insaatRoutes);
app.use('/api/takip',   takipRoutes);
app.use('/api/araclar', araclarRoutes);

app.get('/api/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`window.GMAPS_KEY = "${process.env.GOOGLE_MAPS_API_KEY || ''}";\nwindow.API_BASE = "";`);
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

/* ── AI Asistan: Sevkiyat açıklamasını parse et ── */
app.post('/api/ai/sevkiyat-parse', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Yetkisiz' });
  const { metin } = req.body;
  if (!metin) return res.status(400).json({ error: 'metin zorunlu' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI_DISABLED' });

  try {
    const { Anthropic } = require('@anthropic-ai/sdk');
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey.startsWith('sk-ant-')) return res.status(503).json({ error: 'AI_KEY_INVALID', hint: 'Key "sk-ant-" ile başlamalı, Railway Variables kontrol edin.' });
    const client = new Anthropic({ apiKey });
    const bugun = new Date().toLocaleDateString('tr-TR', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

    const msg = await Promise.race([
      client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: `Sen bir lojistik şirketi için çalışan bir asistansın. Kullanıcının Türkçe sevkiyat açıklamasından yapılandırılmış veri çıkarıyorsun. Bugün: ${bugun}. SADECE JSON döndür, başka metin yok.`,
      messages: [{
        role: 'user',
        content: `Şu sevkiyat açıklamasından bilgileri çıkar: "${metin}"

Döndür (eksik alanlar null olsun):
{
  "kalkis": "şehir/yer adı",
  "varis": "şehir/yer adı",
  "kalkis_zaman": "YYYY-MM-DDTHH:MM" veya null,
  "varis_zaman": "YYYY-MM-DDTHH:MM" veya null,
  "yuk_cinsi": "yük türü" veya null,
  "notlar": "mola saatleri, özel notlar vb" veya null,
  "tahmini_sure_saat": sayı veya null
}`
      }]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('AI_TIMEOUT')), 12000))
    ]);

    const text = msg.content[0].text.trim();
    const json = JSON.parse(text.replace(/```json|```/g, '').trim());
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: "İşlem başarısız oldu." });
  }
});

const PHONE_RE = /^(\+90|0)?[0-9]{10}$/;
function isValidPhone(p) { return p && PHONE_RE.test(String(p).replace(/[\s\-().]/g,'')); }
// Telegram mesajlarında HTML tag injection önler
function tgEscape(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ── YÜK BİLDİRİMİ ── */
app.post('/api/yuk-bildirimi', async (req, res) => {
  try {
    const { ad_soyad, telefon, yuk_tanimi, kaynak } = req.body;
    if (!ad_soyad?.trim() || !telefon || !yuk_tanimi?.trim())
      return res.status(400).json({ error: 'Ad soyad, telefon ve yük tanımı zorunludur.' });
    if (!isValidPhone(telefon))
      return res.status(400).json({ error: 'Geçersiz telefon numarası. (05xx veya +90 formatı)' });
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || '';
    const { rows } = await db.query(
      `INSERT INTO yuk_bildirimleri (ad_soyad, telefon, yuk_tanimi, kaynak, ip)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [ad_soyad.trim(), telefon.trim(), yuk_tanimi.trim(), kaynak || 'anasayfa', ip]
    );
    const { tg } = require('./services/telegram');
    await tg(
      `📦 <b>YENİ YÜK BİLDİRİMİ</b>\n` +
      `👤 <b>${tgEscape(ad_soyad.trim())}</b>\n` +
      `📞 ${tgEscape(telefon.trim())}\n` +
      `🚚 ${tgEscape(yuk_tanimi.trim())}\n` +
      `📍 Kaynak: ${tgEscape(kaynak || 'anasayfa')}\n` +
      `🕐 ${new Date().toLocaleString('tr-TR')}`
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

app.get('/api/yuk-bildirimleri', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Yetkisiz' });
    const { rows } = await db.query(
      `SELECT * FROM yuk_bildirimleri ORDER BY created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

app.patch('/api/yuk-bildirimleri/:id/okundu', async (req, res) => {
  const auth = require('./middleware/auth');
  auth(req, res, async () => {
    try {
      await db.query(`UPDATE yuk_bildirimleri SET okundu=true WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
  });
});

app.delete('/api/yuk-bildirimleri/:id', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Yetkisiz' });
    await db.query(`DELETE FROM yuk_bildirimleri WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

/* ── İLETİŞİM MESAJLARI ── */
app.post('/api/iletisim', async (req, res) => {
  try {
    const { ad_soyad, telefon, mesaj, kaynak } = req.body;
    if (!ad_soyad?.trim() || !telefon || !mesaj?.trim())
      return res.status(400).json({ error: 'Ad soyad, telefon ve mesaj zorunludur.' });
    if (!isValidPhone(telefon))
      return res.status(400).json({ error: 'Geçersiz telefon numarası. (05xx veya +90 formatı)' });
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || '';
    const { rows } = await db.query(
      `INSERT INTO iletisim_mesajlari (ad_soyad, telefon, mesaj, kaynak, ip)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [ad_soyad.trim(), telefon.trim(), mesaj.trim(), kaynak || 'anasayfa', ip]
    );
    const { tg } = require('./services/telegram');
    await tg(
      `📩 <b>YENİ İLETİŞİM MESAJI</b>\n` +
      `👤 <b>${tgEscape(ad_soyad.trim())}</b>\n` +
      `📞 ${tgEscape(telefon.trim())}\n` +
      `💬 ${tgEscape(mesaj.trim())}\n` +
      `📍 Kaynak: ${tgEscape(kaynak || 'anasayfa')}\n` +
      `🌐 IP: <code>${tgEscape(ip)}</code>\n` +
      `🕐 ${new Date().toLocaleString('tr-TR')}`
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

app.get('/api/iletisim', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Yetkisiz' });
    const { rows } = await db.query(
      `SELECT * FROM iletisim_mesajlari ORDER BY created_at DESC LIMIT 300`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

app.delete('/api/iletisim/:id', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Yetkisiz' });
    await db.query(`DELETE FROM iletisim_mesajlari WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

/* ── İK BAŞVURULARI ── */
app.post('/api/ik', (req, res, next) => {
  cvUpload.single('cv')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    const { ad_soyad, telefon, email, pozisyon, deneyim, mesaj, kaynak } = req.body;
    if (!ad_soyad || !telefon || !pozisyon)
      return res.status(400).json({ error: 'Ad soyad, telefon ve pozisyon zorunludur.' });
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || '';
    const cv_path          = req.file ? req.file.filename : null;
    const cv_original_name = req.file ? req.file.originalname : null;
    const { rows } = await db.query(
      `INSERT INTO is_basvurulari (ad_soyad, telefon, email, pozisyon, deneyim, mesaj, kaynak, ip, cv_path, cv_original_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
      [ad_soyad.trim(), telefon.trim(), email||null, pozisyon.trim(), deneyim||null, mesaj||null, kaynak||'ik', ip, cv_path, cv_original_name]
    );
    const { tg } = require('./services/telegram');
    await tg(
      `👔 <b>YENİ İŞ BAŞVURUSU</b>\n` +
      `👤 <b>${ad_soyad.trim()}</b>\n` +
      `📞 ${telefon.trim()}\n` +
      (email ? `📧 ${email}\n` : '') +
      `💼 Pozisyon: ${pozisyon.trim()}\n` +
      (deneyim ? `🏅 Deneyim: ${deneyim}\n` : '') +
      (mesaj ? `💬 Not: ${mesaj.trim()}\n` : '') +
      (cv_path ? `📎 CV eklendi: ${cv_original_name}\n` : '') +
      `🌐 IP: <code>${ip}</code>\n` +
      `🕐 ${new Date().toLocaleString('tr-TR')}`
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    if (req.file) fs.unlink(path.join(CV_DIR, req.file.filename), () => {});
    res.status(500).json({ error: "İşlem başarısız oldu." });
  }
});

app.get('/api/ik', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Yetkisiz' });
    const { rows } = await db.query(
      `SELECT * FROM is_basvurulari ORDER BY created_at DESC LIMIT 300`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

/* ── CV İNDİR ── */
app.get('/api/ik/:id/cv', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Yetkisiz' });
    const { rows } = await db.query(
      `SELECT cv_path, cv_original_name FROM is_basvurulari WHERE id=$1`, [req.params.id]
    );
    if (!rows.length || !rows[0].cv_path)
      return res.status(404).json({ error: 'CV bulunamadı.' });
    // Path traversal koruması
    if (!/^[a-zA-Z0-9_\-\.]+\.pdf$/i.test(rows[0].cv_path))
      return res.status(400).json({ error: 'Geçersiz dosya.' });
    const filePath = path.join(CV_DIR, rows[0].cv_path);
    // Dizin dışına çıkma kontrolü
    if (!filePath.startsWith(CV_DIR))
      return res.status(400).json({ error: 'Geçersiz dosya.' });
    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: 'Dosya sunucuda bulunamadı.' });
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(rows[0].cv_original_name || 'cv.pdf')}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(filePath);
  } catch (e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

app.delete('/api/ik/:id', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Yetkisiz' });
    // CV dosyasını da sil
    const { rows } = await db.query(`SELECT cv_path FROM is_basvurulari WHERE id=$1`, [req.params.id]);
    if (rows.length && rows[0].cv_path) {
      fs.unlink(path.join(CV_DIR, rows[0].cv_path), () => {});
    }
    await db.query(`DELETE FROM is_basvurulari WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

/* ── TEKLİF TALEPLERİ ── */
app.post('/api/teklif', async (req, res) => {
  try {
    const { ad_soyad, telefon, kalkis, varis, km, arac, yuk, fiyat } = req.body;
    if (!ad_soyad || !telefon || !kalkis || !varis)
      return res.status(400).json({ error: 'Zorunlu alanlar eksik.' });
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || '';
    const { rows } = await db.query(
      `INSERT INTO teklifler (ad_soyad, telefon, kalkis, varis, mesafe_km, arac_tipi, yuk_tipi, fiyat_tahmini, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
      [ad_soyad.trim(), telefon.trim(), kalkis, varis, km||0, arac||'', yuk||'', fiyat||0, ip]
    );
    const { tg } = require('./services/telegram');
    const aracAdi = {tir:'Tır Tenteli',onteker:'Onteker',kamyon:'Kamyon'}[arac] || arac;
    const yukAdi  = {tenteli:'Tenteli',frigo:'Soğuk Zincir (Frigo)',tehlikeli:'Tehlikeli Madde'}[yuk] || yuk;
    await tg(
      `💰 <b>YENİ TEKLİF TALEBİ</b>\n` +
      `👤 <b>${ad_soyad.trim()}</b>\n` +
      `📞 ${telefon.trim()}\n` +
      `🗺️ ${kalkis} → ${varis} (${km} km)\n` +
      `🚛 Araç: ${aracAdi}\n` +
      `📦 Yük: ${yukAdi}\n` +
      `💵 Tahmini: ${Number(fiyat).toLocaleString('tr-TR')} ₺\n` +
      `🕐 ${new Date().toLocaleString('tr-TR')}`
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

app.get('/api/teklifler', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Yetkisiz' });
    const { rows } = await db.query(
      `SELECT * FROM teklifler ORDER BY created_at DESC LIMIT 300`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

app.delete('/api/teklifler/:id', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Yetkisiz' });
    await db.query(`DELETE FROM teklifler WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

/* ── CHAT SESSION SİL ── */
app.delete('/api/chat/:sessionId', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Yetkisiz' });
    const sid = req.params.sessionId;
    // Önce mesajları sil (CASCADE yoksa bile çalışsın)
    await db.query(`DELETE FROM chat_messages WHERE session_id=$1`, [sid]).catch(() => {});
    await db.query(`DELETE FROM telegram_mappings WHERE session_id=$1`, [sid]).catch(() => {});
    await db.query(`DELETE FROM chat_sessions WHERE session_id=$1`, [sid]);
    // Memory'den sil ve admin'lere güncel listeyi gönder
    if (visitors.has(sid)) {
      const v = visitors.get(sid);
      v.messages = [];
      // Ziyaretçi hâlâ bağlıysa socket'ını bildir
      if (v.socketId) {
        io.to(v.socketId).emit('chat:reset');
      }
      visitors.delete(sid);
    }
    broadcastVisitors();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

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
    clickCount:  v.clickCount  || 0,
    formFills:   v.formFills   || 0,
    scrollDepth: v.scrollDepth || 0,
    pageHistory: v.pageHistory,
    activity:    v.activity,
    messages:    v.messages,
  }));
  io.to('admins').emit('visitors:update', list);
}

/* ── Socket.IO session ID validation ── */
function isValidSessionId(sid) {
  return typeof sid === 'string' && /^[a-zA-Z0-9_\-]{8,64}$/.test(sid);
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
  socket.on('visitor:connect', async ({ sessionId, name, phone, page, pageTitle, device, referrer }) => {
    if (!isValidSessionId(sessionId)) return;
    // Ad ve telefon uzunluk sınırı
    const safeName  = typeof name  === 'string' ? name.slice(0, 100)  : 'Ziyaretçi';
    const safePhone = typeof phone === 'string' ? phone.slice(0, 20)  : '';
    name  = safeName;
    phone = safePhone;
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
        referrer:      referrer || '',
        country:       null,
        city:          null,
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
      if (referrer) v.referrer = referrer;
    }
    socket.sessionId = sessionId;

    // GeoIP — sadece yeni ziyaretçiler veya konum bilinmiyorsa
    if (isNew || !v.country) {
      geoIP(ip).then(geo => {
        v.country = geo.country;
        v.city    = geo.city;
        broadcastVisitors();
      }).catch(() => {});
    }

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
    // Telegram — sadece yeni ziyaretçileri bildir (geo sonuçlanınca gönder)
    if (isNew) {
      setTimeout(() => {
        tgVisitorOnline(v.name, v.page || '/', {
          ip:       v.ip,
          country:  v.country,
          city:     v.city,
          referrer: v.referrer,
          device:   v.device,
        }).catch(() => {});
      }, 2000); // ip-api.com'un yanıt vermesi için kısa bekleme
    }
    // Mesaj geçmişini gönder
    if (v.messages.length > 0) {
      socket.emit('chat:history', v.messages);
    }
  });

  /* ── Ziyaretçi sayfa değiştirdi ── */
  socket.on('visitor:page', ({ sessionId, page, pageTitle }) => {
    if (!isValidSessionId(sessionId)) return;
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
    if (!isValidSessionId(sessionId)) return;
    const v = visitors.get(sessionId);
    if (!v) return;
    v.lastSeen = new Date().toISOString();

    // İstatistikler
    if (!v.clickCount)   v.clickCount   = 0;
    if (!v.formFills)    v.formFills    = 0;
    if (!v.scrollDepth)  v.scrollDepth  = 0;
    if (action === 'click' || action === 'nav_click') v.clickCount++;
    if (action === 'form_fill')  v.formFills++;
    if (action === 'scroll') {
      const pct = parseInt(detail) || 0;
      if (pct > v.scrollDepth) v.scrollDepth = pct;
    }

    const entry = { type: 'action', action, detail, time: new Date().toISOString() };
    v.activity.push(entry);
    if (v.activity.length > 100) v.activity.shift();
    io.to('admins').emit('visitor:activity', { sessionId, ...entry });

    // ── Telegram bildirimleri (önemli olaylar) ──
    const { tg } = require('./services/telegram');
    const who = `${tgEscape(v.name)}${v.phone ? ' · ' + tgEscape(v.phone) : ''}${v.city ? ' · ' + tgEscape(v.city) : ''}`;

    if (action === 'booking_attempt') {
      tg(`🚀 <b>REZERVASYON GİRİŞİMİ</b>\n👤 ${who}\n📄 ${tgEscape(v.page || '/')}\n📋 ${tgEscape(detail || '')}`).catch(() => {});
    } else if (action === 'form_fill') {
      // Telefon veya isim girildiğinde bildir (kişisel veri içerdiğinden değerli)
      const low = (detail || '').toLowerCase();
      if (low.includes('telefon') || low.includes('tel') || low.includes('phone') ||
          low.includes('ad ') || low.includes('isim') || low.includes('pozisyon')) {
        if (!v._formTgTimer) {
          v._formTgTimer = setTimeout(() => {
            v._formTgTimer = null;
            tg(`✍️ <b>FORM DOLDURUYOR</b>\n👤 ${who}\n📄 ${tgEscape((v.page||'/').replace(/https?:\/\/[^/]+/,''))}\n📝 ${tgEscape(detail || '')}`).catch(() => {});
          }, 3000);
        }
      }
    } else if (action === 'scroll') {
      const pct = parseInt(detail) || 0;
      if (pct === 100) {
        // Sayfayı tamamen okudu — sadece bir kez bildir
        if (!v._scroll100Notified) {
          v._scroll100Notified = true;
          tg(`📜 <b>SAYFA TAMAMEN OKUNDU</b>\n👤 ${who}\n📄 ${tgEscape((v.page||'/').replace(/https?:\/\/[^/]+/,''))}`).catch(() => {});
        }
      }
    }
  });

  /* ── Ziyaretçi mesaj gönderdi ── */
  socket.on('visitor:message', ({ sessionId, text, name, phone }) => {
    if (!isValidSessionId(sessionId)) return;
    if (!text || typeof text !== 'string' || text.trim().length === 0) return;
    let v = visitors.get(sessionId);
    if (!v) return;
    if (name && name !== 'Ziyaretçi') v.name = String(name).slice(0, 100);
    if (phone) v.phone = String(phone).slice(0, 20);
    const safeText = text.slice(0, 2000);
    const msg = { from: 'visitor', senderName: v.name, text: safeText, time: new Date().toISOString(), id: Date.now(), read: false };
    v.messages.push(msg);
    v.lastSeen = new Date().toISOString();
    db.query(
      `INSERT INTO chat_messages (session_id, from_type, sender_name, text, read) VALUES ($1,'visitor',$2,$3,false)`,
      [sessionId, v.name, safeText]
    ).catch(() => {});
    db.query(`UPDATE chat_sessions SET name=$2, phone=$3, last_seen=NOW() WHERE session_id=$1`,
      [sessionId, v.name, v.phone || null]
    ).catch(() => {});
    io.to('admins').emit('chat:sync', { sessionId, message: msg });
    broadcastVisitors();
    tgChatMessage(v.name, v.phone, safeText, sessionId, { ip: v.ip, country: v.country, city: v.city }).catch(() => {});
    socket.emit('chat:delivered', { id: msg.id });
  });

  /* ── Ziyaretçi yazıyor (canlı metin önizleme) ── */
  socket.on('visitor:typing', ({ sessionId, typing, text }) => {
    if (!isValidSessionId(sessionId)) return;
    io.to('admins').emit('chat:visitor_typing', { sessionId, typing, text: (text || '').slice(0, 500) });
    if (text && text.length > 0) {
      const v = visitors.get(sessionId);
      if (!v) return;
      // Önceki timer'ı temizle
      if (v._typingTgTimer) clearTimeout(v._typingTgTimer);
      v._lastTypingText = text;
      v._typingTgTimer = setTimeout(() => {
        const { tg } = require('./services/telegram');
        tg(
          `⌨️ <b>ZİYARETÇİ YAZIYOR</b>\n` +
          `👤 ${v.name}${v.phone ? ' | 📞 ' + v.phone : ''}\n` +
          `📝 <i>${text}</i>\n` +
          `🌐 IP: <code>${v.ip || '?'}</code>`
        ).catch(() => {});
      }, 2500);
    }
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

// Tüm tabloları otomatik oluştur
db.query(`
  CREATE TABLE IF NOT EXISTS admins (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    email      VARCHAR(150) UNIQUE NOT NULL,
    password   VARCHAR(255) NOT NULL,
    role       VARCHAR(20)  DEFAULT 'admin',
    created_at TIMESTAMPTZ  DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS drivers (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    phone      VARCHAR(20)  NOT NULL,
    plate      VARCHAR(20)  NOT NULL,
    status     VARCHAR(20)  DEFAULT 'available',
    created_at TIMESTAMPTZ  DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS transfer_routes (
    id         SERIAL PRIMARY KEY,
    from_point VARCHAR(150) NOT NULL,
    to_point   VARCHAR(150) NOT NULL,
    price      NUMERIC(10,2) NOT NULL,
    duration   VARCHAR(50),
    active     BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS users (
    id               SERIAL PRIMARY KEY,
    name             VARCHAR(100) NOT NULL,
    email            VARCHAR(150) UNIQUE NOT NULL,
    phone            VARCHAR(20)  UNIQUE NOT NULL,
    password         VARCHAR(255) NOT NULL,
    phone_verified   BOOLEAN      DEFAULT FALSE,
    otp_code         VARCHAR(6),
    otp_expires_at   TIMESTAMPTZ,
    created_at       TIMESTAMPTZ  DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
  CREATE TABLE IF NOT EXISTS bookings (
    id              SERIAL PRIMARY KEY,
    booking_ref     VARCHAR(20)  UNIQUE NOT NULL,
    customer_name   VARCHAR(100) NOT NULL,
    customer_phone  VARCHAR(20)  NOT NULL,
    customer_email  VARCHAR(150),
    from_point      VARCHAR(150) NOT NULL,
    to_point        VARCHAR(150) NOT NULL,
    transfer_date   DATE NOT NULL,
    transfer_time   TIME NOT NULL,
    passenger_count INTEGER      DEFAULT 1,
    flight_number   VARCHAR(20),
    price           NUMERIC(10,2) NOT NULL,
    status          VARCHAR(30)  DEFAULT 'pending',
    driver_id       INTEGER REFERENCES drivers(id),
    payment_status  VARCHAR(20)  DEFAULT 'unpaid',
    payment_id      VARCHAR(100),
    notes           TEXT,
    created_at      TIMESTAMPTZ  DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_date   ON bookings(transfer_date);
  CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
  CREATE INDEX IF NOT EXISTS idx_bookings_ref    ON bookings(booking_ref);
  CREATE TABLE IF NOT EXISTS payments (
    id           SERIAL PRIMARY KEY,
    booking_id   INTEGER REFERENCES bookings(id),
    amount       NUMERIC(10,2) NOT NULL,
    installment  INTEGER DEFAULT 1,
    iyzico_token VARCHAR(255),
    status       VARCHAR(20) DEFAULT 'pending',
    created_at   TIMESTAMPTZ DEFAULT NOW()
  );
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
  CREATE TABLE IF NOT EXISTS kurumlar (
    id SERIAL PRIMARY KEY, kurum_adi VARCHAR(200) NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL,
    yetkili_ad VARCHAR(100), yetkili_tel VARCHAR(20),
    is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW(), last_login TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_kurumlar_username ON kurumlar(username);
  CREATE TABLE IF NOT EXISTS ihaleler (
    id         SERIAL PRIMARY KEY,
    kurum      TEXT NOT NULL,
    baslik     TEXT NOT NULL,
    tur        VARCHAR(100) NOT NULL,
    durum      VARCHAR(20)  NOT NULL CHECK (durum IN ('tamamlandi','devam')),
    sira       INTEGER      DEFAULT 0,
    created_at TIMESTAMPTZ  DEFAULT NOW(),
    updated_at TIMESTAMPTZ  DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_ihaleler_durum ON ihaleler(durum);
  CREATE TABLE IF NOT EXISTS insaatlar (
    id          SERIAL PRIMARY KEY,
    baslik      TEXT         NOT NULL,
    aciklama    TEXT,
    proje_yili  INTEGER      NOT NULL,
    durum       VARCHAR(20)  NOT NULL CHECK (durum IN ('tamamlandi','devam')),
    konum       TEXT,
    sira        INTEGER      DEFAULT 0,
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_insaatlar_durum ON insaatlar(durum);
  CREATE TABLE IF NOT EXISTS insaat_fotograflar (
    id            SERIAL PRIMARY KEY,
    insaat_id     INTEGER      NOT NULL REFERENCES insaatlar(id) ON DELETE CASCADE,
    fotograf_path TEXT         NOT NULL,
    sira          INTEGER      DEFAULT 1,
    created_at    TIMESTAMPTZ  DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_insaat_foto_insaat ON insaat_fotograflar(insaat_id);
  CREATE TABLE IF NOT EXISTS sevkiyatlar (
    id                SERIAL PRIMARY KEY,
    takip_kodu        VARCHAR(20)  UNIQUE NOT NULL,
    musteri_adi       VARCHAR(100) NOT NULL,
    musteri_tel       VARCHAR(20),
    kalkis            TEXT         NOT NULL,
    varis             TEXT         NOT NULL,
    durum             VARCHAR(20)  NOT NULL DEFAULT 'beklemede'
                        CHECK (durum IN ('beklemede','yolda','teslim_edildi','iptal')),
    arac_plaka        VARCHAR(20),
    surucu_adi        VARCHAR(100),
    mevcut_konum      VARCHAR(50),
    mevcut_konum_adi  TEXT,
    tahmini_teslim    TIMESTAMPTZ,
    notlar            TEXT,
    created_at        TIMESTAMPTZ  DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_sevkiyatlar_kod ON sevkiyatlar(takip_kodu);
  CREATE TABLE IF NOT EXISTS araclar (
    id          SERIAL PRIMARY KEY,
    plaka       VARCHAR(20) NOT NULL,
    marka_model VARCHAR(100),
    arac_tipi   VARCHAR(50) NOT NULL DEFAULT 'kamyon',
    yuk_cinsi   VARCHAR(100),
    kapasite    VARCHAR(50),
    surucu_adi  VARCHAR(100),
    surucu_tel  VARCHAR(20),
    durum       VARCHAR(20) NOT NULL DEFAULT 'musait'
                  CHECK (durum IN ('musait','seferde','bakim')),
    notlar      TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS yuk_bildirimleri (
    id         SERIAL PRIMARY KEY,
    ad_soyad   VARCHAR(100) NOT NULL,
    telefon    VARCHAR(30)  NOT NULL,
    yuk_tanimi TEXT         NOT NULL,
    kaynak     VARCHAR(50)  DEFAULT 'anasayfa',
    ip         VARCHAR(50),
    okundu     BOOLEAN      DEFAULT FALSE,
    created_at TIMESTAMPTZ  DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_yuk_bildirimleri_tarih ON yuk_bildirimleri(created_at DESC);
  CREATE TABLE IF NOT EXISTS iletisim_mesajlari (
    id         SERIAL PRIMARY KEY,
    ad_soyad   VARCHAR(100) NOT NULL,
    telefon    VARCHAR(30)  NOT NULL,
    mesaj      TEXT         NOT NULL,
    kaynak     VARCHAR(50)  DEFAULT 'anasayfa',
    ip         VARCHAR(50),
    okundu     BOOLEAN      DEFAULT FALSE,
    created_at TIMESTAMPTZ  DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_iletisim_tarih ON iletisim_mesajlari(created_at DESC);
  CREATE TABLE IF NOT EXISTS is_basvurulari (
    id               SERIAL PRIMARY KEY,
    ad_soyad         VARCHAR(100) NOT NULL,
    telefon          VARCHAR(30)  NOT NULL,
    email            VARCHAR(150),
    pozisyon         VARCHAR(150) NOT NULL,
    deneyim          VARCHAR(100),
    mesaj            TEXT,
    kaynak           VARCHAR(50)  DEFAULT 'ik',
    ip               VARCHAR(50),
    okundu           BOOLEAN      DEFAULT FALSE,
    cv_path          VARCHAR(255),
    cv_original_name VARCHAR(255),
    created_at       TIMESTAMPTZ  DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_is_basvuru_tarih ON is_basvurulari(created_at DESC);
  CREATE TABLE IF NOT EXISTS teklifler (
    id             SERIAL PRIMARY KEY,
    ad_soyad       VARCHAR(100) NOT NULL,
    telefon        VARCHAR(30)  NOT NULL,
    kalkis         TEXT,
    varis          TEXT,
    mesafe_km      NUMERIC(8,2),
    arac_tipi      VARCHAR(50),
    yuk_tipi       VARCHAR(100),
    fiyat_tahmini  NUMERIC(10,2),
    ip             VARCHAR(50),
    okundu         BOOLEAN     DEFAULT FALSE,
    created_at     TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_teklifler_tarih ON teklifler(created_at DESC);
  -- Mevcut tabloya CV kolonlarını ekle (zaten varsa hata vermez)
  ALTER TABLE is_basvurulari ADD COLUMN IF NOT EXISTS cv_path VARCHAR(255);
  ALTER TABLE is_basvurulari ADD COLUMN IF NOT EXISTS cv_original_name VARCHAR(255);
  -- Sevkiyatlar tablosuna yeni kolon ekle
  ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS kalkis_lat    DOUBLE PRECISION;
  ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS kalkis_lng    DOUBLE PRECISION;
  ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS varis_lat     DOUBLE PRECISION;
  ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS varis_lng     DOUBLE PRECISION;
  ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS mevcut_lat    DOUBLE PRECISION;
  ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS mevcut_lng    DOUBLE PRECISION;
  ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS rota_polyline TEXT;
  ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS mesafe_km     NUMERIC(8,2);
  ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS sure_dakika   INTEGER;
  ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS arac_id       INTEGER REFERENCES araclar(id) ON DELETE SET NULL;
  ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS yuk_cinsi     VARCHAR(100);
  ALTER TABLE araclar ADD COLUMN IF NOT EXISTS son_lat       DOUBLE PRECISION;
  ALTER TABLE araclar ADD COLUMN IF NOT EXISTS son_lng       DOUBLE PRECISION;
  ALTER TABLE araclar ADD COLUMN IF NOT EXISTS son_konum_adi TEXT;
  ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS kalkis_zamani TIMESTAMPTZ;
  ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS kurum_id      INTEGER REFERENCES kurumlar(id) ON DELETE SET NULL;
`).then(async () => {
  // Varsayılan admin ve rotaları seed et (sadece boşsa)
  const bcrypt = require('bcryptjs');
  const { rows: admins } = await db.query('SELECT id FROM admins LIMIT 1').catch(() => ({ rows: [] }));
  if (!admins.length) {
    const hash = await bcrypt.hash('Guliz2025!', 12);
    await db.query(
      `INSERT INTO admins (name, email, password, role) VALUES ('Süper Admin', 'admin@guliztransfer.com', $1, 'superadmin') ON CONFLICT DO NOTHING`,
      [hash]
    ).catch(() => {});
    console.log('👤 Admin oluşturuldu: admin@guliztransfer.com / Guliz2025!');
  }
  const { rows: routes } = await db.query('SELECT id FROM transfer_routes LIMIT 1').catch(() => ({ rows: [] }));
  if (!routes.length) {
    await db.query(`
      INSERT INTO transfer_routes (from_point, to_point, price, duration) VALUES
        ('Gazipaşa Havalimanı (GZP)', 'Alanya Merkez',    650,  '25-35 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Alanya Mahmutlar', 750,  '35-45 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Alanya Oba',       700,  '30-40 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Alanya Kestel',    720,  '30-40 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Alanya Avsallar',  800,  '40-50 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Gazipaşa Merkez',  400,  '10-15 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Side',             950,  '60-75 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Manavgat',         900,  '55-70 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Antalya Merkez',   1350, '90-110 dk')
      ON CONFLICT DO NOTHING`
    ).catch(() => {});
    console.log('🗺️  Transfer rotaları oluşturuldu.');
  }
  // İhale seed — WHERE NOT EXISTS ile idempotent, her startup'ta çalışır
  const ihaleRows = [
    ["1'inci Deniz İstihkam Tabur K. Lığı",                  'Milli Savunma Bakanlığı – MSB Bağlıları',               'Nakliye İşi',       'tamamlandi', 1],
    ['Isparta Kapalı Ve Açık Ceza İnfaz Kurumu İşyurdu',     'Ceza İnfaz Kurumları İle Tutukevleri İş Yurtları Kurumu','Nakliye İşi',       'tamamlandi', 2],
    ['Devrek Açık Ceza İnfaz Kurumu İşyurdu Müdürlüğü',      'Ceza İnfaz Kurumları İle Tutukevleri İş Yurtları Kurumu','Nakliye İşi',       'tamamlandi', 3],
    ['Çanakkale Açık Ceza İnfaz Kurumu İşyurdu',             'Diğer Özel Bütçeli Kuruluşlar',                         'Nakliye İşi',       'tamamlandi', 4],
    ['Adana 2 Nolu Açık Ceza İnfaz Kurumu İşyurdu Müdürlüğü','Ceza İnfaz Kurumları İle Tutukevleri İş Yurtları Kurumu','Nakliye İşi',       'tamamlandi', 5],
    ['Antakya Açık Ceza İnfaz Kurumu İşyurdu Müdürlüğü',     'Ceza İnfaz Kurumları İle Tutukevleri İş Yurtları Kurumu','Nakliye İşi',       'tamamlandi', 6],
    ['Bafra Açık Ceza İnfaz Kurumu İşyurdu Müdürlüğü',       'Ceza İnfaz Kurumları İle Tutukevleri İş Yurtları Kurumu','Nakliye İşi',       'tamamlandi', 7],
    ['Öğretmen Evi Ve Akşam Sanat Okulu Müdürlüğü',          'Milli Eğitim Bakanlığı – Antalya Öğretmenevi',          'Personel Alım İşi', 'devam',      1],
  ];
  let eklenen = 0;
  for (const [baslik, kurum, tur, durum, sira] of ihaleRows) {
    const r = await db.query(
      `INSERT INTO ihaleler (kurum, baslik, tur, durum, sira)
       SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS (SELECT 1 FROM ihaleler WHERE baslik=$2)`,
      [kurum, baslik, tur, durum, sira]
    ).catch(e => { console.error('İhale seed hatası:', e.message); return { rowCount: 0 }; });
    eklenen += r.rowCount || 0;
  }
  if (eklenen > 0) console.log(`🏗️  ${eklenen} ihale verisi eklendi.`);

}).catch(e => console.error('Tablo oluşturma hatası:', e.message));

/* ── 404 handler ── */
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint bulunamadı.' });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'), err => {
    if (err) res.status(404).send('Sayfa bulunamadı.');
  });
});

/* ── Global error handler ── */
app.use((err, req, res, _next) => {
  console.error('Uncaught error:', err.message || err);
  res.status(500).json({ error: 'Sunucu hatası oluştu.' });
});

/* ── Bağımsız sütun migration'ları — ana blok hata alsa bile çalışır ── */
(async () => {
  const cols = [
    `ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS kalkis_zamani TIMESTAMPTZ`,
    `ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS kurum_id INTEGER REFERENCES kurumlar(id) ON DELETE SET NULL`,
    `ALTER TABLE sevkiyatlar ADD COLUMN IF NOT EXISTS son_konum_adi TEXT`,
  ];
  for (const sql of cols) {
    await db.query(sql).catch(e => console.warn('Migration uyarısı:', e.message));
  }
  console.log('✅ Sütun migration\'ları tamamlandı.');
})();

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ Güliz Transfer API çalışıyor → http://localhost:${PORT}`);
  console.log(`🌐 Müşteri sitesi          → http://localhost:${PORT}/`);
  console.log(`🔧 Admin paneli            → http://localhost:${PORT}/admin.html`);
});

function gracefulShutdown(signal) {
  console.log(`${signal} alındı, kapatılıyor...`);
  io.close();
  server.close(() => {
    console.log('Sunucu kapatıldı.');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  // Sadece logla, uygulamayı kapatma — Railway tekrar başlatır gereksiz yere
  console.error('Yakalanmamış hata:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('Yakalanmamış promise reddi:', reason);
});
