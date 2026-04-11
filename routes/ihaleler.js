const router = require('express').Router();
const db     = require('../models/db');
const auth   = require('../middleware/auth');

// Tüm ihaleleri getir (public)
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM ihaleler ORDER BY durum DESC, sira ASC, id ASC'
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Yeni ihale ekle (admin)
router.post('/', auth, async (req, res) => {
  const { kurum, baslik, tur, durum } = req.body;
  if (!kurum || !baslik || !tur || !durum)
    return res.status(400).json({ error: 'kurum, baslik, tur, durum zorunludur' });
  try {
    const { rows } = await db.query(
      `INSERT INTO ihaleler (kurum, baslik, tur, durum)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [kurum.trim(), baslik.trim(), tur.trim(), durum]
    );
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// İhale güncelle (admin)
router.put('/:id', auth, async (req, res) => {
  const { kurum, baslik, tur, durum, sira } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE ihaleler
       SET kurum=$1, baslik=$2, tur=$3, durum=$4, sira=COALESCE($5, sira), updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [kurum, baslik, tur, durum, sira ?? null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bulunamadı' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// İhale sil (admin)
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM ihaleler WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
