const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../models/db');
const adminAuth = require('../middleware/auth');

/* ── Kurum JWT ── */
function kurumToken(kurum) {
  return jwt.sign(
    { id: kurum.id, username: kurum.username, type: 'kurum' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function kurumAuth(req, res, next) {
  const h = req.headers['authorization'];
  if (!h) return res.status(401).json({ error: 'Token gerekli' });
  try {
    const p = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET);
    if (p.type !== 'kurum') return res.status(403).json({ error: 'Yetkisiz' });
    req.kurum = p;
    next();
  } catch { res.status(401).json({ error: 'Geçersiz token' }); }
}

/* ── Admin: Kurum listesi ── */
router.get('/', adminAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, kurum_adi, username, yetkili_ad, yetkili_tel, is_active, created_at, last_login
       FROM kurumlar ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

/* ── Admin: Kurum oluştur ── */
router.post('/', adminAuth, async (req, res) => {
  const { kurum_adi, username, password, yetkili_ad, yetkili_tel } = req.body;
  if (!kurum_adi || !username || !password)
    return res.status(400).json({ error: 'kurum_adi, username ve password zorunludur' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      `INSERT INTO kurumlar (kurum_adi, username, password, yetkili_ad, yetkili_tel)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, kurum_adi, username, yetkili_ad, yetkili_tel, is_active, created_at`,
      [kurum_adi, username, hash, yetkili_ad || null, yetkili_tel || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Bu kullanıcı adı zaten kullanılıyor' });
    res.status(500).json({ error: "İşlem başarısız oldu." });
  }
});

/* ── Admin: Kurum güncelle (aktif/pasif & şifre) ── */
router.put('/:id', adminAuth, async (req, res) => {
  const { kurum_adi, yetkili_ad, yetkili_tel, is_active, password } = req.body;
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      await db.query('UPDATE kurumlar SET password=$1 WHERE id=$2', [hash, req.params.id]);
    }
    const { rows } = await db.query(
      `UPDATE kurumlar
       SET kurum_adi=$1, yetkili_ad=$2, yetkili_tel=$3, is_active=$4
       WHERE id=$5
       RETURNING id, kurum_adi, username, yetkili_ad, yetkili_tel, is_active`,
      [kurum_adi, yetkili_ad, yetkili_tel, is_active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Kurum bulunamadı' });
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

/* ── Admin: Kurum sil ── */
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM kurumlar WHERE id=$1', [req.params.id]);
    res.json({ message: 'Kurum silindi' });
  } catch (e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

/* ── Public: Kurum giriş ── */
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli' });
  try {
    const { rows } = await db.query('SELECT * FROM kurumlar WHERE username=$1', [username]);
    if (!rows.length) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
    const kurum = rows[0];
    if (!kurum.is_active) return res.status(403).json({ error: 'Bu hesap devre dışı bırakılmıştır' });
    const ok = await bcrypt.compare(password, kurum.password);
    if (!ok) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
    await db.query('UPDATE kurumlar SET last_login=NOW() WHERE id=$1', [kurum.id]);
    const token = kurumToken(kurum);
    res.json({
      token,
      kurum: { id: kurum.id, kurum_adi: kurum.kurum_adi, username: kurum.username, yetkili_ad: kurum.yetkili_ad }
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

/* ── Kurum: Kendi sevkiyatları ── */
router.get('/:id/sevkiyatlar', kurumAuth, async (req, res) => {
  if (req.kurum.id !== parseInt(req.params.id))
    return res.status(403).json({ error: 'Yetkisiz' });
  try {
    const { rows } = await db.query(
      `SELECT takip_kodu, kalkis, varis, durum, arac_plaka, surucu_adi,
              mevcut_konum_adi, kalkis_zamani, tahmini_teslim, created_at, updated_at
       FROM sevkiyatlar WHERE kurum_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

/* ── Kurum: Kendi bilgisi ── */
router.get('/me', kurumAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, kurum_adi, username, yetkili_ad, yetkili_tel, last_login FROM kurumlar WHERE id=$1',
      [req.kurum.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bulunamadı' });
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

module.exports = router;
