const express = require('express');
const router  = express.Router();
const db      = require('../models/db');
const auth    = require('../middleware/auth');

const DURUM_LABEL = {
  beklemede:     'Beklemede',
  yolda:         'Yolda',
  teslim_edildi: 'Teslim Edildi',
  iptal:         'İptal',
};

/* ── Herkese açık: takip kodu sorgula ── */
router.get('/sorgula/:kod', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT takip_kodu, musteri_adi, kalkis, varis, durum,
              arac_plaka, surucu_adi, mevcut_konum, mevcut_konum_adi,
              tahmini_teslim, created_at, updated_at
       FROM sevkiyatlar WHERE takip_kodu = $1`,
      [req.params.kod.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Takip kodu bulunamadı.' });
    const s = rows[0];
    res.json({ ...s, durum_label: DURUM_LABEL[s.durum] || s.durum });
  } catch (e) {
    res.status(500).json({ error: 'Sunucu hatası.' });
  }
});

/* ── Admin: tüm sevkiyatlar ── */
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM sevkiyatlar ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Admin: yeni sevkiyat ── */
router.post('/', auth, async (req, res) => {
  const { musteri_adi, musteri_tel, kalkis, varis, arac_plaka,
          surucu_adi, mevcut_konum, mevcut_konum_adi, tahmini_teslim, notlar } = req.body;

  if (!musteri_adi || !kalkis || !varis)
    return res.status(400).json({ error: 'Müşteri adı, kalkış ve varış zorunlu.' });

  // Benzersiz takip kodu üret
  const kod = 'GLZ' + Date.now().toString(36).toUpperCase().slice(-6);

  try {
    const { rows } = await db.query(
      `INSERT INTO sevkiyatlar
         (takip_kodu, musteri_adi, musteri_tel, kalkis, varis, arac_plaka,
          surucu_adi, mevcut_konum, mevcut_konum_adi, tahmini_teslim, notlar)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [kod, musteri_adi, musteri_tel||null, kalkis, varis, arac_plaka||null,
       surucu_adi||null, mevcut_konum||null, mevcut_konum_adi||null,
       tahmini_teslim||null, notlar||null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Admin: güncelle ── */
router.put('/:id', auth, async (req, res) => {
  const { durum, arac_plaka, surucu_adi, mevcut_konum,
          mevcut_konum_adi, tahmini_teslim, notlar } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE sevkiyatlar SET
         durum=$1, arac_plaka=$2, surucu_adi=$3,
         mevcut_konum=$4, mevcut_konum_adi=$5,
         tahmini_teslim=$6, notlar=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [durum, arac_plaka||null, surucu_adi||null, mevcut_konum||null,
       mevcut_konum_adi||null, tahmini_teslim||null, notlar||null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bulunamadı.' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Admin: sil ── */
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM sevkiyatlar WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
