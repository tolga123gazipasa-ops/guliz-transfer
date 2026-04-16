const express = require('express');
const router  = express.Router();
const db      = require('../models/db');
const auth    = require('../middleware/auth');

/* ── Public: seferdeki araçlar (hassas bilgi yok) ── */
router.get('/public', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, plaka, arac_tipi, durum FROM araclar WHERE durum='seferde' ORDER BY plaka`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Admin: tüm araçlar ── */
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM araclar ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Admin: araç ekle ── */
router.post('/', auth, async (req, res) => {
  const { plaka, marka_model, arac_tipi, yuk_cinsi, kapasite, surucu_adi, surucu_tel, durum, notlar } = req.body;
  if (!plaka) return res.status(400).json({ error: 'Plaka zorunludur.' });
  try {
    const { rows } = await db.query(
      `INSERT INTO araclar (plaka, marka_model, arac_tipi, yuk_cinsi, kapasite, surucu_adi, surucu_tel, durum, notlar)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [plaka.trim(), marka_model||null, arac_tipi||'kamyon', yuk_cinsi||null, kapasite||null,
       surucu_adi||null, surucu_tel||null, durum||'musait', notlar||null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Admin: araç güncelle ── */
router.put('/:id', auth, async (req, res) => {
  const { plaka, marka_model, arac_tipi, yuk_cinsi, kapasite, surucu_adi, surucu_tel, durum, notlar } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE araclar SET plaka=$1, marka_model=$2, arac_tipi=$3, yuk_cinsi=$4, kapasite=$5,
       surucu_adi=$6, surucu_tel=$7, durum=$8, notlar=$9
       WHERE id=$10 RETURNING *`,
      [plaka, marka_model||null, arac_tipi||'kamyon', yuk_cinsi||null, kapasite||null,
       surucu_adi||null, surucu_tel||null, durum||'musait', notlar||null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Araç bulunamadı.' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Admin: araç sil ── */
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM araclar WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
