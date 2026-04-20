const express = require('express');
const router  = express.Router();
const db      = require('../models/db');
const auth    = require('../middleware/auth');
const { tgSevkiyatYolda, tgSevkiyatTeslim } = require('../services/telegram');
const { sendSms } = require('../services/sms');

function formatPhone(tel) {
  if (!tel) return null;
  const d = tel.replace(/\D/g, '');
  if (d.startsWith('90') && d.length === 12) return '+' + d;
  if (d.startsWith('0')  && d.length === 11) return '+9' + d;
  if (d.length === 10) return '+90' + d;
  return tel;
}

const DURUM_LABEL = {
  beklemede:     'Beklemede',
  yolda:         'Yolda',
  teslim_edildi: 'Teslim Edildi',
  iptal:         'İptal',
};

/* ── Herkese açık: aktif sevkiyatlar (koordinatlı) ── */
router.get('/aktif', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT takip_kodu, kalkis, varis, durum, arac_plaka,
              mevcut_konum_adi, mevcut_lat, mevcut_lng, kalkis_lat, kalkis_lng, varis_lat, varis_lng
       FROM sevkiyatlar WHERE durum='yolda' AND mevcut_lat IS NOT NULL ORDER BY updated_at DESC`
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

/* ── Herkese açık: takip kodu sorgula ── */
router.get('/sorgula/:kod', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT takip_kodu, musteri_adi, kalkis, varis, durum,
              arac_plaka, surucu_adi, mevcut_konum, mevcut_konum_adi,
              tahmini_teslim, created_at, updated_at,
              kalkis_lat, kalkis_lng, varis_lat, varis_lng,
              mevcut_lat, mevcut_lng, rota_polyline, mesafe_km, sure_dakika, yuk_cinsi
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

/* ── Admin: tüm sevkiyatlar (sürücü adı ve telefonu JOIN ile) ── */
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*, d.name AS driver_name, d.phone AS driver_phone, d.plate AS driver_plate
       FROM sevkiyatlar s
       LEFT JOIN drivers d ON s.driver_id = d.id
       ORDER BY s.created_at DESC`
    );
    res.json(rows);
  } catch (e) {
    // driver_id kolonu henüz yoksa sadece sevkiyatları dön
    try {
      const { rows } = await db.query('SELECT * FROM sevkiyatlar ORDER BY created_at DESC');
      res.json(rows);
    } catch(e2) {
      res.status(500).json({ error: "İşlem başarısız oldu." });
    }
  }
});

/* ── Admin: yeni sevkiyat ── */
router.post('/', auth, async (req, res) => {
  const { musteri_adi, musteri_tel, kalkis, varis, arac_plaka,
          surucu_adi, mevcut_konum, mevcut_konum_adi, tahmini_teslim, notlar,
          kalkis_lat, kalkis_lng, varis_lat, varis_lng, mevcut_lat, mevcut_lng,
          rota_polyline, mesafe_km, sure_dakika, arac_id, yuk_cinsi,
          kalkis_zamani, kurum_id, driver_id } = req.body;

  if (!musteri_adi || !kalkis || !varis)
    return res.status(400).json({ error: 'Müşteri adı, kalkış ve varış zorunlu.' });

  const kod = 'GLZ' + Date.now().toString(36).toUpperCase().slice(-6);

  try {
    const { rows } = await db.query(
      `INSERT INTO sevkiyatlar
         (takip_kodu, musteri_adi, musteri_tel, kalkis, varis, arac_plaka,
          surucu_adi, mevcut_konum, mevcut_konum_adi, tahmini_teslim, notlar,
          kalkis_lat, kalkis_lng, varis_lat, varis_lng, mevcut_lat, mevcut_lng,
          rota_polyline, mesafe_km, sure_dakika, arac_id, yuk_cinsi)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [kod, musteri_adi, musteri_tel||null, kalkis, varis, arac_plaka||null,
       surucu_adi||null, mevcut_konum||null, mevcut_konum_adi||null,
       tahmini_teslim||null, notlar||null,
       kalkis_lat||null, kalkis_lng||null, varis_lat||null, varis_lng||null,
       mevcut_lat||null, mevcut_lng||null,
       rota_polyline||null, mesafe_km||null, sure_dakika||null,
       arac_id||null, yuk_cinsi||null]
    );
    const sevk = rows[0];
    // kalkis_zamani / kurum_id / driver_id — migration sonrası sütunlar, yoksa sessizce geç
    if (kalkis_zamani || kurum_id || driver_id) {
      await db.query(
        `UPDATE sevkiyatlar SET kalkis_zamani=$1, kurum_id=$2, driver_id=$3 WHERE id=$4`,
        [kalkis_zamani||null, kurum_id||null, driver_id||null, sevk.id]
      ).catch(() => {});
    }
    res.status(201).json(sevk);
  } catch (e) {
    res.status(500).json({ error: "İşlem başarısız oldu." });
  }
});

/* ── Admin: güncelle ── */
router.put('/:id', auth, async (req, res) => {
  const { durum, arac_plaka, surucu_adi, mevcut_konum,
          mevcut_konum_adi, tahmini_teslim, notlar,
          mevcut_lat, mevcut_lng, mevcut_konum: mevcut_konum2,
          kalkis_lat, kalkis_lng, varis_lat, varis_lng,
          rota_polyline, mesafe_km, sure_dakika, arac_id, yuk_cinsi,
          musteri_adi, musteri_tel, kalkis, varis,
          kalkis_zamani, kurum_id, driver_id } = req.body;
  const mKonum = mevcut_konum !== undefined ? mevcut_konum : mevcut_konum2;
  try {
    // Bildirim için eski durumu önce al
    const { rows: eski } = await db.query('SELECT durum FROM sevkiyatlar WHERE id=$1', [req.params.id]);
    const eskiDurum = eski[0]?.durum;

    const { rows } = await db.query(
      `UPDATE sevkiyatlar SET
         durum=$1, arac_plaka=$2, surucu_adi=$3,
         mevcut_konum=$4, mevcut_konum_adi=$5,
         tahmini_teslim=$6, notlar=$7,
         mevcut_lat=$8, mevcut_lng=$9,
         kalkis_lat=$10, kalkis_lng=$11,
         varis_lat=$12, varis_lng=$13,
         rota_polyline=$14, mesafe_km=$15, sure_dakika=$16,
         arac_id=$17, yuk_cinsi=$18,
         musteri_adi=COALESCE($19, musteri_adi),
         musteri_tel=COALESCE($20, musteri_tel),
         kalkis=COALESCE($21, kalkis),
         varis=COALESCE($22, varis),
         updated_at=NOW()
       WHERE id=$23 RETURNING *`,
      [durum, arac_plaka||null, surucu_adi||null, mKonum||null,
       mevcut_konum_adi||null, tahmini_teslim||null, notlar||null,
       mevcut_lat||null, mevcut_lng||null,
       kalkis_lat||null, kalkis_lng||null,
       varis_lat||null, varis_lng||null,
       rota_polyline||null, mesafe_km||null, sure_dakika||null,
       arac_id||null, yuk_cinsi||null,
       musteri_adi||null, musteri_tel||null, kalkis||null, varis||null,
       req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bulunamadı.' });
    let guncellenen = rows[0];

    // kalkis_zamani / kurum_id / driver_id — migration sonrası sütunlar
    if (kalkis_zamani !== undefined || kurum_id !== undefined || driver_id !== undefined) {
      await db.query(
        `UPDATE sevkiyatlar SET
           kalkis_zamani=COALESCE($1, kalkis_zamani),
           kurum_id=$2,
           driver_id=$3
         WHERE id=$4`,
        [kalkis_zamani||null, kurum_id||null, driver_id||null, req.params.id]
      ).catch(() => {});
    }

    // Durum değiştiyse bildirimler gönder
    if (durum && durum !== eskiDurum) {
      if (durum === 'yolda') {
        tgSevkiyatYolda(guncellenen).catch(() => {});
        // Araca "seferde" durumu ata
        if (guncellenen.arac_id) {
          db.query(`UPDATE araclar SET durum='seferde' WHERE id=$1`, [guncellenen.arac_id]).catch(() => {});
        }
        // Müşteriye SMS
        const tel = formatPhone(guncellenen.musteri_tel);
        if (tel) sendSms(tel, `Guliz Transfer: Sevkiyatiniz yola cikti. Takip kodu: ${guncellenen.takip_kodu} | gulizlojistik.com`).catch(() => {});
      }
      if (durum === 'teslim_edildi') {
        tgSevkiyatTeslim(guncellenen).catch(() => {});
        // Araca "müsait" durumu ata
        if (guncellenen.arac_id) {
          db.query(`UPDATE araclar SET durum='musait' WHERE id=$1`, [guncellenen.arac_id]).catch(() => {});
        }
        // Müşteriye SMS
        const tel = formatPhone(guncellenen.musteri_tel);
        if (tel) sendSms(tel, `Guliz Transfer: Sevkiyatiniz teslim edildi. Takip kodu: ${guncellenen.takip_kodu}. Hizmetimizi tercih ettiginiz icin tesekkur ederiz.`).catch(() => {});
      }
      if (durum === 'iptal') {
        if (guncellenen.arac_id) {
          db.query(`UPDATE araclar SET durum='musait' WHERE id=$1`, [guncellenen.arac_id]).catch(() => {});
        }
      }
    }

    res.json(guncellenen);
  } catch (e) {
    res.status(500).json({ error: "İşlem başarısız oldu." });
  }
});

/* ── Admin: sil ── */
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM sevkiyatlar WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "İşlem başarısız oldu." });
  }
});

module.exports = router;
