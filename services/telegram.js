require('dotenv').config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

async function tg(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('[TELEGRAM - DEV]', text);
    return null;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
    const data = await res.json();
    if (!data.ok) { console.error('[TELEGRAM] Hata:', data.description); return null; }
    return data.result; // mesaj objesi (message_id içerir)
  } catch (e) {
    console.error('[TELEGRAM] İstek hatası:', e.message);
    return null;
  }
}

/* ── Bot polling (Telegram'dan komut alma) ── */
let _getVisitors = null;
let _io          = null;
let _lastUpdateId = 0;

// Telegram mesaj ID → sessionId eşleşmesi (reply yönlendirme için)
const msgSessionMap = new Map(); // telegramMsgId → sessionId

/**
 * @param {() => object[]} getVisitorsFn  - visitors Map'ini dizi olarak döner
 * @param {object}         ioInstance     - socket.io Server instance (cevap göndermek için)
 */
function initBot(getVisitorsFn, ioInstance) {
  _getVisitors = getVisitorsFn;
  _io          = ioInstance;
  if (!BOT_TOKEN) {
    console.log('[TELEGRAM BOT] Token yok, bot polling başlatılmadı.');
    return;
  }
  console.log('[TELEGRAM BOT] Komut dinleme başladı...');
  pollUpdates();
}

async function pollUpdates() {
  try {
    const res  = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${_lastUpdateId + 1}&timeout=30`,
      { signal: AbortSignal.timeout(35000) }
    );
    const data = await res.json();
    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        _lastUpdateId = update.update_id;
        handleCommand(update).catch(e => console.error('[BOT] komut hatası:', e.message));
      }
    }
  } catch (e) {
    if (e.name !== 'TimeoutError' && e.name !== 'AbortError')
      console.error('[TELEGRAM BOT] Poll hatası:', e.message);
  }
  setTimeout(pollUpdates, 500);
}

async function sendReply(chatId, text) {
  if (!BOT_TOKEN) return;
  // Telegram mesaj limiti 4096 karakter
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML' }),
    }).catch(() => {});
  }
}

async function handleCommand(update) {
  const msg = update.message || update.channel_post;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const raw    = msg.text.trim().split('@')[0]; // /komut@BotAdi → /komut
  const parts  = raw.split(/\s+/);
  const cmd    = parts[0].toLowerCase();

  /* ─── Telegram mesajına direkt REPLY ile cevap ─── */
  if (msg.reply_to_message) {
    const replyToId = msg.reply_to_message.message_id;
    let sessionId   = msgSessionMap.get(replyToId);

    // Memory'de yoksa DB'den bak (restart sonrası için)
    if (!sessionId) {
      const db = require('../models/db');
      const { rows } = await db.query(
        `SELECT session_id FROM telegram_mappings WHERE telegram_msg_id=$1`, [replyToId]
      ).catch(() => ({ rows: [] }));
      if (rows.length) sessionId = rows[0].session_id;
    }

    if (sessionId) {
      const metin    = msg.text.trim();
      const msgObj   = { from: 'admin', senderName: 'Yönetici', text: metin, time: new Date().toISOString(), id: Date.now() };
      const visitors = _getVisitors ? _getVisitors() : [];
      const v        = visitors.find(v => v.sessionId === sessionId);

      if (v) {
        v.messages.push(msgObj);
        if (_io) {
          if (v.socketId) _io.to(v.socketId).emit('chat:message', msgObj);
          _io.to('admins').emit('chat:sync', { sessionId: v.sessionId, message: msgObj });
        }
      }

      // Mesajı DB'ye kaydet
      const db = require('../models/db');
      db.query(
        `INSERT INTO chat_messages (session_id, from_type, sender_name, text, read) VALUES ($1,'admin','Yönetici',$2,true)`,
        [sessionId, metin]
      ).catch(() => {});

      await sendReply(chatId, v
        ? `✅ <b>${v.name}</b>'a mesaj gönderildi:\n"${metin}"`
        : `✅ Mesaj kaydedildi (ziyaretçi şu an çevrimdışı).`
      );
      return;
    }
  }

  /* ─── /yardim ─── */
  if (cmd === '/start' || cmd === '/yardim') {
    await sendReply(chatId,
      `🤖 <b>Güliz Transfer — Yönetim Komutları</b>\n\n` +
      `<b>📋 Rezervasyonlar</b>\n` +
      `/rezervasyonlar — Son bekleyen rezervasyonlar\n` +
      `/onayla GT-XXXXX — Rezervasyonu onayla\n` +
      `/iptal GT-XXXXX — Rezervasyonu iptal et\n\n` +
      `<b>🚗 Sürücüler</b>\n` +
      `/suruculer — Sürücü listesi\n\n` +
      `<b>👁️ Ziyaretçiler</b>\n` +
      `/ziyaretciler — Sitedeki aktif kullanıcılar\n` +
      `/mesajlar — Okunmamış destek mesajları\n` +
      `/cevap N mesaj — N numaralı ziyaretçiye yanıt yaz\n\n` +
      `<b>📊 Genel</b>\n` +
      `/istatistik — Özet istatistikler\n` +
      `/yardim — Bu listeyi göster`
    );
    return;
  }

  /* ─── /ziyaretciler ─── */
  if (cmd === '/ziyaretciler' || cmd === '/aktif') {
    const visitors = _getVisitors ? _getVisitors() : [];
    const online   = visitors.filter(v => v.online);
    if (!online.length) {
      await sendReply(chatId, '👁️ Şu an aktif ziyaretçi yok.');
      return;
    }
    let reply = `👁️ <b>AKTİF ZİYARETÇİLER (${online.length})</b>\n\n`;
    online.forEach((v, i) => {
      const dk = Math.round((Date.now() - new Date(v.startTime)) / 60000);
      reply += `<b>#${i + 1}</b> 👤 ${v.name}${v.phone ? ' | 📞 ' + v.phone : ''}\n`;
      reply += `   📱 ${v.device} | ⏱️ ${dk} dk\n`;
      reply += `   🌐 ${v.pageTitle || v.page}\n`;
      if (v.messages.length) reply += `   💬 ${v.messages.length} mesaj\n`;
      reply += '\n';
    });
    reply += `💡 Yanıt için: /cevap 1 Merhaba, nasıl yardımcı olabilirim?`;
    await sendReply(chatId, reply.trim());
    return;
  }

  /* ─── /istatistik ─── */
  if (cmd === '/istatistik') {
    const db       = require('../models/db');
    const visitors = _getVisitors ? _getVisitors() : [];
    const online   = visitors.filter(v => v.online).length;
    const toplam   = visitors.length;
    const okunmamis = visitors.reduce((acc, v) =>
      acc + v.messages.filter(m => m.from === 'visitor' && !m.read).length, 0);

    const { rows: rezRows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='pending')   AS bekleyen,
         COUNT(*) FILTER (WHERE status='confirmed') AS onaylandı,
         COUNT(*) FILTER (WHERE DATE(created_at)=CURRENT_DATE) AS bugun
       FROM bookings`
    );
    const r = rezRows[0];
    await sendReply(chatId,
      `📊 <b>ÖZET İSTATİSTİK</b>\n\n` +
      `<b>Ziyaretçiler</b>\n` +
      `🟢 Aktif: ${online} | 👥 24s: ${toplam} | 📨 Okunmamış: ${okunmamis}\n\n` +
      `<b>Rezervasyonlar</b>\n` +
      `⏳ Bekleyen: ${r.bekleyen} | ✅ Onaylı: ${r.onaylandi} | 📅 Bugün: ${r.bugun}`
    );
    return;
  }

  /* ─── /mesajlar ─── */
  if (cmd === '/mesajlar') {
    const visitors  = _getVisitors ? _getVisitors() : [];
    const okunmamis = visitors.filter(v =>
      v.messages.some(m => m.from === 'visitor' && !m.read)
    );
    if (!okunmamis.length) {
      await sendReply(chatId, '✅ Okunmamış destek mesajı yok.');
      return;
    }
    let reply = `📨 <b>OKUNMAMIŞ MESAJLAR</b>\n\n`;
    const allOnline = (_getVisitors ? _getVisitors() : []).filter(v => v.online);
    okunmamis.forEach(v => {
      const idx  = allOnline.indexOf(v) + 1;
      const msgs = v.messages.filter(m => m.from === 'visitor' && !m.read);
      reply += `${idx > 0 ? `<b>#${idx}</b> ` : ''}👤 <b>${v.name}</b>${v.phone ? ' | ' + v.phone : ''}\n`;
      for (const m of msgs.slice(-3)) reply += `  ✉️ ${m.text}\n`;
      reply += '\n';
    });
    await sendReply(chatId, reply.trim());
    return;
  }

  /* ─── /cevap N mesaj metni ─── */
  if (cmd === '/cevap') {
    // /cevap 1 Merhaba, yardımcı olabilirim!
    const num  = parseInt(parts[1]);
    const metin = parts.slice(2).join(' ');
    if (!num || !metin) {
      await sendReply(chatId, '❌ Kullanım: /cevap <numara> <mesaj>\nÖrnek: /cevap 1 Merhaba!');
      return;
    }
    const online = (_getVisitors ? _getVisitors() : []).filter(v => v.online);
    const v      = online[num - 1];
    if (!v) {
      await sendReply(chatId, `❌ #${num} numaralı aktif ziyaretçi bulunamadı. /ziyaretciler ile listeye bakın.`);
      return;
    }
    const msgObj = { from: 'admin', senderName: 'Yönetici', text: metin, time: new Date().toISOString(), id: Date.now() };
    v.messages.push(msgObj);
    if (_io) {
      if (v.socketId) _io.to(v.socketId).emit('chat:message', msgObj);
      _io.to('admins').emit('chat:sync', { sessionId: v.sessionId, message: msgObj });
    }
    await sendReply(chatId, `✅ <b>${v.name}</b>'a mesaj gönderildi:\n"${metin}"`);
    return;
  }

  /* ─── /rezervasyonlar ─── */
  if (cmd === '/rezervasyonlar') {
    const db     = require('../models/db');
    const filtre = parts[1] || 'bekleyen';
    let statusFilter = '';
    if (filtre === 'bekleyen')  statusFilter = `WHERE b.status='pending'`;
    else if (filtre === 'onaylı' || filtre === 'onaylandı') statusFilter = `WHERE b.status='confirmed'`;
    else if (filtre === 'bugün' || filtre === 'bugun')
      statusFilter = `WHERE DATE(b.transfer_date)=CURRENT_DATE`;

    const { rows } = await db.query(
      `SELECT b.*, d.name as driver_name FROM bookings b
       LEFT JOIN drivers d ON b.driver_id=d.id
       ${statusFilter} ORDER BY b.created_at DESC LIMIT 10`
    );
    if (!rows.length) {
      await sendReply(chatId, `📋 ${filtre} rezervasyon bulunamadı.`); return;
    }
    const statusEmoji = { pending:'⏳', confirmed:'✅', assigned:'🚗', completed:'🏁', cancelled:'❌' };
    let reply = `📋 <b>REZERVASYONLAR</b> (${filtre.toUpperCase()})\n\n`;
    for (const b of rows) {
      reply += `${statusEmoji[b.status] || '•'} <code>${b.booking_ref}</code>\n`;
      reply += `👤 ${b.customer_name} | 📞 ${b.customer_phone}\n`;
      reply += `📍 ${b.from_point} → ${b.to_point}\n`;
      reply += `📅 ${b.transfer_date} ${b.transfer_time} | 👥 ${b.passenger_count} kişi\n`;
      reply += `💰 ₺${parseInt(b.price).toLocaleString('tr-TR')}`;
      if (b.driver_name) reply += ` | 🚗 ${b.driver_name}`;
      reply += '\n\n';
    }
    reply += `💡 /onayla GT-XXXXX  veya  /iptal GT-XXXXX`;
    await sendReply(chatId, reply.trim());
    return;
  }

  /* ─── /onayla GT-XXXXX ─── */
  if (cmd === '/onayla') {
    const db  = require('../models/db');
    const ref = parts[1]?.toUpperCase();
    if (!ref) { await sendReply(chatId, '❌ Kullanım: /onayla GT-XXXXX'); return; }
    const { rows } = await db.query(
      `UPDATE bookings SET status='confirmed' WHERE booking_ref=$1 AND status='pending' RETURNING *`, [ref]
    );
    if (!rows.length) {
      await sendReply(chatId, `❌ <code>${ref}</code> bulunamadı veya zaten işleme alınmış.`); return;
    }
    const b = rows[0];
    await sendReply(chatId,
      `✅ <b>REZERVASYON ONAYLANDI</b>\n` +
      `📋 <code>${b.booking_ref}</code>\n` +
      `👤 ${b.customer_name} | 📞 ${b.customer_phone}\n` +
      `📍 ${b.from_point} → ${b.to_point}\n` +
      `📅 ${b.transfer_date} ${b.transfer_time}`
    );
    return;
  }

  /* ─── /iptal GT-XXXXX ─── */
  if (cmd === '/iptal') {
    const db  = require('../models/db');
    const ref = parts[1]?.toUpperCase();
    if (!ref) { await sendReply(chatId, '❌ Kullanım: /iptal GT-XXXXX'); return; }
    const { rows } = await db.query(
      `UPDATE bookings SET status='cancelled' WHERE booking_ref=$1
       AND status NOT IN ('completed','cancelled') RETURNING *`, [ref]
    );
    if (!rows.length) {
      await sendReply(chatId, `❌ <code>${ref}</code> bulunamadı veya iptal edilemez durumda.`); return;
    }
    const b = rows[0];
    await sendReply(chatId,
      `❌ <b>REZERVASYON İPTAL EDİLDİ</b>\n` +
      `📋 <code>${b.booking_ref}</code>\n` +
      `👤 ${b.customer_name}\n` +
      `📅 ${b.transfer_date} ${b.transfer_time}`
    );
    return;
  }

  /* ─── /suruculer ─── */
  if (cmd === '/suruculer') {
    const db = require('../models/db');
    const { rows } = await db.query(`SELECT * FROM drivers ORDER BY status, name`);
    if (!rows.length) { await sendReply(chatId, '🚗 Kayıtlı sürücü yok.'); return; }
    const statusEmoji = { available:'🟢', busy:'🔴', offline:'⚫' };
    let reply = `🚗 <b>SÜRÜCÜ LİSTESİ</b>\n\n`;
    for (const d of rows) {
      reply += `${statusEmoji[d.status] || '•'} <b>${d.name}</b> | ${d.plate}\n`;
      reply += `   📞 ${d.phone}\n`;
    }
    await sendReply(chatId, reply.trim());
    return;
  }
}

/* ── Yeni Rezervasyon ── */
function tgNewBooking(b) {
  return tg(
    `🚘 <b>YENİ REZERVASYON</b>\n` +
    `📋 Ref: <code>${b.booking_ref}</code>\n` +
    `👤 Müşteri: ${b.customer_name}\n` +
    `📞 Telefon: ${b.customer_phone}\n` +
    `📍 Güzergah: ${b.from_point} → ${b.to_point}\n` +
    `📅 Tarih/Saat: ${b.transfer_date} ${b.transfer_time}\n` +
    `👥 Yolcu: ${b.passenger_count}\n` +
    `💰 Fiyat: ₺${parseInt(b.price).toLocaleString('tr-TR')}`
  );
}

/* ── Ödeme Alındı ── */
function tgPayment(b, amount) {
  return tg(
    `💳 <b>ÖDEME ALINDI</b>\n` +
    `📋 Ref: <code>${b.booking_ref}</code>\n` +
    `👤 Müşteri: ${b.customer_name}\n` +
    `💰 Tutar: ₺${parseInt(amount).toLocaleString('tr-TR')}`
  );
}

/* ── Yeni Üye ── */
function tgNewUser(u) {
  return tg(
    `👤 <b>YENİ ÜYE</b>\n` +
    `🏷️ Ad: ${u.name}\n` +
    `📧 E-posta: ${u.email}\n` +
    `📞 Telefon: ${u.phone}`
  );
}

/* ── Kullanıcı Giriş Yaptı ── */
function tgUserLogin(u, ip) {
  return tg(
    `🔐 <b>ÜYE GİRİŞİ</b>\n` +
    `👤 ${u.name}\n` +
    `📧 ${u.email}\n` +
    `📞 ${u.phone}` +
    (ip ? `\n🌐 IP: <code>${ip}</code>` : '') +
    `\n🕐 ${new Date().toLocaleString('tr-TR')}`
  );
}

/* ── Admin Giriş Yaptı ── */
function tgAdminLogin(u, ip) {
  return tg(
    `🛡️ <b>ADMİN GİRİŞİ</b>\n` +
    `👤 ${u.name}\n` +
    `📧 ${u.email}\n` +
    `🔑 Rol: ${u.role || 'admin'}` +
    (ip ? `\n🌐 IP: <code>${ip}</code>` : '') +
    `\n🕐 ${new Date().toLocaleString('tr-TR')}`
  );
}

/* ── Canlı Destek Mesajı ── */
async function tgChatMessage(name, phone, text, sessionId, extra) {
  const loc = (extra && (extra.country || extra.city))
    ? `\n📍 ${[extra.city, extra.country].filter(Boolean).join(', ')}`
    : '';
  const ip  = (extra && extra.ip) ? `\n🌐 IP: <code>${extra.ip}</code>` : '';
  const result = await tg(
    `💬 <b>CANLI DESTEK MESAJI</b>\n` +
    `👤 ${name}${phone ? '\n📞 ' + phone : ''}${loc}${ip}\n` +
    `✉️ ${text}\n\n` +
    `<i>↩️ Bu mesaja reply yaparak yanıtlayabilirsiniz.</i>`
  );
  if (result && sessionId) {
    msgSessionMap.set(result.message_id, sessionId);
    setTimeout(() => msgSessionMap.delete(result.message_id), 2 * 60 * 60 * 1000);
    // DB'ye de kaydet (restart sonrası da çalışsın)
    const db = require('../models/db');
    db.query(
      `INSERT INTO telegram_mappings (telegram_msg_id, session_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [result.message_id, sessionId]
    ).catch(() => {});
  }
}

/* ── Ziyaretçi Bağlandı ── */
function tgVisitorOnline(name, page, extra) {
  const ip       = (extra && extra.ip)       ? `\n🌐 IP: <code>${extra.ip}</code>`       : '';
  const country  = (extra && extra.country)  ? `\n🏳️ ${extra.country}${extra.city ? ', ' + extra.city : ''}` : '';
  const referrer = (extra && extra.referrer) ? `\n↩️ Kaynak: ${extra.referrer}`           : '';
  const device   = (extra && extra.device)   ? `\n📱 ${extra.device}`                     : '';
  return tg(
    `👁️ <b>ZİYARETÇİ BAĞLANDI</b>\n` +
    `👤 ${name}\n` +
    `📄 ${page}` +
    device + country + ip + referrer
  );
}

module.exports = { tg, tgNewBooking, tgPayment, tgNewUser, tgUserLogin, tgAdminLogin, tgChatMessage, tgVisitorOnline, initBot };
