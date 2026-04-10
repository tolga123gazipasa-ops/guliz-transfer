const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../models/db');
const authMW  = require('../middleware/auth');
const { sendWelcomeEmail, sendOtpEmail, notifyAdminNewUser } = require('../services/email');
const { sendOtp, notifyAdminSms } = require('../services/sms');
const { tgNewUser, tgUserLogin } = require('../services/telegram');

function genOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }
function genToken(user) {
  return jwt.sign({ id: user.id, email: user.email, type: 'user' }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

/* ── Kayıt ── */
router.post('/register', async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !phone || !password)
    return res.status(400).json({ error: 'Tüm alanlar zorunludur' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı' });

  try {
    const { rows: ex } = await db.query('SELECT id FROM users WHERE email=$1 OR phone=$2', [email, phone]);
    if (ex.length) return res.status(409).json({ error: 'Bu e-posta veya telefon zaten kayıtlı' });

    const hash = await bcrypt.hash(password, 12);
    const otp  = genOtp();
    const otpExp = new Date(Date.now() + 10 * 60 * 1000); // 10 dk

    const { rows } = await db.query(
      `INSERT INTO users (name, email, phone, password, otp_code, otp_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, phone, phone_verified`,
      [name, email, phone, hash, otp, otpExp]
    );
    const user = rows[0];

    // SMS gönder (hata olsa bile devam et)
    sendOtp(phone, otp).catch(e => console.error('SMS hatası:', e.message));
    // E-posta yedek OTP + hoş geldin
    sendOtpEmail(user, otp).catch(() => {});
    sendWelcomeEmail(user).catch(() => {});
    // Yönetici bildirimleri
    notifyAdminNewUser(user).catch(() => {});
    notifyAdminSms(`[GULIZ] Yeni uye: ${name} | ${phone}`).catch(() => {});
    tgNewUser(user).catch(() => {});

    res.status(201).json({
      message: 'Kayıt başarılı. Telefonunuza doğrulama kodu gönderildi.',
      userId: user.id,
      needsVerification: true,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── SMS Doğrula ── */
router.post('/verify-phone', async (req, res) => {
  const { userId, code } = req.body;
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [userId]);
    if (!rows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    const user = rows[0];
    if (user.otp_code !== code)
      return res.status(400).json({ error: 'Doğrulama kodu hatalı' });
    if (new Date() > new Date(user.otp_expires_at))
      return res.status(400).json({ error: 'Doğrulama kodunun süresi doldu' });

    await db.query('UPDATE users SET phone_verified=true, otp_code=NULL, otp_expires_at=NULL WHERE id=$1', [userId]);
    const token = genToken(user);
    res.json({ message: 'Telefon doğrulandı', token, user: { id: user.id, name: user.name, email: user.email, phone: user.phone } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── OTP yeniden gönder ── */
router.post('/resend-otp', async (req, res) => {
  const { userId } = req.body;
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [userId]);
    if (!rows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    const user = rows[0];
    const otp  = genOtp();
    const otpExp = new Date(Date.now() + 10 * 60 * 1000);
    await db.query('UPDATE users SET otp_code=$1, otp_expires_at=$2 WHERE id=$3', [otp, otpExp, userId]);
    sendOtp(user.phone, otp).catch(e => console.error('SMS:', e.message));
    sendOtpEmail(user, otp).catch(() => {});
    res.json({ message: 'Kod yeniden gönderildi' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Giriş ── */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Hatalı e-posta veya şifre' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Hatalı e-posta veya şifre' });
    const token = genToken(user);
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
    tgUserLogin(user, ip).catch(() => {});
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone, phone_verified: user.phone_verified },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Şifremi Unuttum — telefon ile OTP gönder ── */
router.post('/forgot-password', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Telefon numarası zorunludur' });
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE phone=$1', [phone]);
    // Güvenlik: kullanıcı yoksa bile aynı mesajı döndür
    if (!rows.length) return res.json({ message: 'Kod gönderildi', userId: null });
    const user = rows[0];
    const otp    = genOtp();
    const otpExp = new Date(Date.now() + 10 * 60 * 1000);
    await db.query('UPDATE users SET otp_code=$1, otp_expires_at=$2 WHERE id=$3', [otp, otpExp, user.id]);
    const msg = `Guliz Transfer sifre sifirlama kodunuz: ${otp}. Gecerlilik: 10 dakika. Bu kodu kimseyle paylasmayiniz.`;
    sendOtp(phone, msg).catch(e => console.error('SMS:', e.message));
    sendOtpEmail(user, otp).catch(() => {});
    res.json({ message: 'Kod gönderildi', userId: user.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Şifre Sıfırla — OTP doğrula + yeni şifre ── */
router.post('/reset-password', async (req, res) => {
  const { userId, code, newPassword } = req.body;
  if (!userId || !code || !newPassword)
    return res.status(400).json({ error: 'Tüm alanlar zorunludur' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı' });
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [userId]);
    if (!rows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    const user = rows[0];
    if (user.otp_code !== code)
      return res.status(400).json({ error: 'Doğrulama kodu hatalı' });
    if (new Date() > new Date(user.otp_expires_at))
      return res.status(400).json({ error: 'Kodun süresi doldu. Yeniden talep edin.' });
    const hash = await bcrypt.hash(newPassword, 12);
    await db.query('UPDATE users SET password=$1, otp_code=NULL, otp_expires_at=NULL WHERE id=$2', [hash, userId]);
    res.json({ message: 'Şifre başarıyla güncellendi. Giriş yapabilirsiniz.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Profil (auth gerekli) ── */
const userAuth = (req, res, next) => {
  const h = req.headers['authorization'];
  if (!h) return res.status(401).json({ error: 'Token gerekli' });
  try {
    const p = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET);
    if (p.type !== 'user') return res.status(403).json({ error: 'Yetkisiz' });
    req.user = p;
    next();
  } catch { res.status(401).json({ error: 'Geçersiz token' }); }
};

router.get('/me', userAuth, async (req, res) => {
  const { rows } = await db.query('SELECT id,name,email,phone,phone_verified,created_at FROM users WHERE id=$1', [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Bulunamadı' });
  res.json(rows[0]);
});

router.put('/me', userAuth, async (req, res) => {
  const { name, phone } = req.body;
  try {
    const { rows } = await db.query('UPDATE users SET name=$1, phone=$2 WHERE id=$3 RETURNING id,name,email,phone', [name, phone, req.user.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
