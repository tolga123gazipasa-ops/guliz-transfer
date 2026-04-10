const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('../models/db');
const authMW = require('../middleware/auth');
const { tgAdminLogin } = require('../services/telegram');

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await db.query('SELECT * FROM admins WHERE email=$1', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Hatalı e-posta veya şifre' });
    const ok = await bcrypt.compare(password, rows[0].password);
    if (!ok) return res.status(401).json({ error: 'Hatalı e-posta veya şifre' });
    const token = jwt.sign(
      { id: rows[0].id, email: rows[0].email, role: rows[0].role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
    tgAdminLogin(rows[0], ip).catch(() => {});
    res.json({ token, admin: { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: rows[0].role } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/change-password', authMW, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Yeni şifre en az 6 karakter olmalı' });
  try {
    const { rows } = await db.query('SELECT * FROM admins WHERE id=$1', [req.admin.id]);
    const ok = await bcrypt.compare(currentPassword, rows[0].password);
    if (!ok) return res.status(400).json({ error: 'Mevcut şifre hatalı' });
    const hash = await bcrypt.hash(newPassword, 12);
    await db.query('UPDATE admins SET password=$1 WHERE id=$2', [hash, req.admin.id]);
    res.json({ message: 'Şifre güncellendi' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/update-profile', authMW, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Ad ve e-posta zorunlu' });
  try {
    const { rows: existing } = await db.query('SELECT id FROM admins WHERE email=$1 AND id!=$2', [email, req.admin.id]);
    if (existing.length) return res.status(400).json({ error: 'Bu e-posta zaten kullanımda' });
    const { rows } = await db.query(
      'UPDATE admins SET name=$1, email=$2 WHERE id=$3 RETURNING id, name, email, role',
      [name, email, req.admin.id]
    );
    res.json({ message: 'Profil güncellendi', admin: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
