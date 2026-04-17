const express = require('express');
const router  = express.Router();
const db      = require('../models/db');
const auth    = require('../middleware/auth');

/* ── Public: tüm araçlar — konum + sefer bilgisiyle (hassas bilgi yok) ── */
router.get('/public', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT a.id, a.plaka, a.arac_tipi, a.durum, a.yuk_cinsi,
        COALESCE(s.mevcut_lat,  a.son_lat)       AS lat,
        COALESCE(s.mevcut_lng,  a.son_lng)       AS lng,
        COALESCE(s.mevcut_konum_adi, a.son_konum_adi) AS konum_adi,
        s.kalkis_lat, s.kalkis_lng,
        s.varis_lat,  s.varis_lng,
        s.kalkis      AS sevk_kalkis,
        s.varis       AS sevk_varis,
        s.tahmini_teslim,
        COALESCE(s.kalkis_zamani, s.created_at) AS sevk_baslangic
      FROM araclar a
      LEFT JOIN LATERAL (
        SELECT mevcut_lat, mevcut_lng, mevcut_konum_adi,
               kalkis_lat, kalkis_lng, varis_lat, varis_lng,
               kalkis, varis, tahmini_teslim, kalkis_zamani, created_at
        FROM sevkiyatlar
        WHERE arac_id = a.id AND durum = 'yolda'
        ORDER BY updated_at DESC LIMIT 1
      ) s ON true
      ORDER BY a.created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Admin: tüm araçlar (aktif sevkiyat konumuyla birlikte) ── */
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT a.*,
        COALESCE(s.mevcut_lat, a.son_lat)       AS konum_lat,
        COALESCE(s.mevcut_lng, a.son_lng)       AS konum_lng,
        COALESCE(s.mevcut_konum_adi, a.son_konum_adi) AS konum_adi,
        s.takip_kodu, s.kalkis AS sevk_kalkis, s.varis AS sevk_varis
      FROM araclar a
      LEFT JOIN LATERAL (
        SELECT mevcut_lat, mevcut_lng, mevcut_konum_adi, takip_kodu, kalkis, varis
        FROM sevkiyatlar
        WHERE arac_id = a.id AND durum = 'yolda'
        ORDER BY updated_at DESC LIMIT 1
      ) s ON true
      ORDER BY a.created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Admin: araç konumu güncelle ── */
router.patch('/:id/konum', auth, async (req, res) => {
  const { lat, lng, konum_adi } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE araclar SET son_lat=$1, son_lng=$2, son_konum_adi=$3 WHERE id=$4 RETURNING *`,
      [lat || null, lng || null, konum_adi || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Araç bulunamadı.' });
    res.json(rows[0]);
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
