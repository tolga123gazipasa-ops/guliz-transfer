const router  = require('express').Router();
const db      = require('../models/db');
const auth    = require('../middleware/auth');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

/* ── Multer disk storage ── */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../public/uploads/insaat');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `insaat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`;
    cb(null, name);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|png|webp|gif)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Sadece resim dosyası yükleyebilirsiniz.'));
  },
});

/* ══════════════════════════════════════
   PUBLIC ENDPOINTS
══════════════════════════════════════ */

// Tüm inşaatları getir (fotograflar dahil)
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT i.*, COALESCE(
        json_agg(
          json_build_object('id', f.id, 'url', f.fotograf_path, 'sira', f.sira)
          ORDER BY f.sira ASC, f.id ASC
        ) FILTER (WHERE f.id IS NOT NULL),
        '[]'
      ) AS fotograflar
       FROM insaatlar i
       LEFT JOIN insaat_fotograflar f ON f.insaat_id = i.id
       GROUP BY i.id
       ORDER BY i.durum DESC, i.sira ASC, i.id ASC`
    );
    res.json(rows);
  } catch(e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

// Tek inşaat
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT i.*, COALESCE(
        json_agg(
          json_build_object('id', f.id, 'url', f.fotograf_path, 'sira', f.sira)
          ORDER BY f.sira ASC, f.id ASC
        ) FILTER (WHERE f.id IS NOT NULL),
        '[]'
      ) AS fotograflar
       FROM insaatlar i
       LEFT JOIN insaat_fotograflar f ON f.insaat_id = i.id
       WHERE i.id = $1
       GROUP BY i.id`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bulunamadı' });
    res.json(rows[0]);
  } catch(e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

/* ══════════════════════════════════════
   ADMIN ENDPOINTS
══════════════════════════════════════ */

// Yeni inşaat ekle
router.post('/', auth, async (req, res) => {
  const { baslik, aciklama, proje_yili, durum, konum } = req.body;
  if (!baslik || !proje_yili || !durum)
    return res.status(400).json({ error: 'baslik, proje_yili ve durum zorunludur' });
  try {
    const { rows } = await db.query(
      `INSERT INTO insaatlar (baslik, aciklama, proje_yili, durum, konum)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [baslik.trim(), aciklama?.trim() || null, parseInt(proje_yili), durum, konum?.trim() || null]
    );
    res.status(201).json(rows[0]);
  } catch(e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

// İnşaat güncelle
router.put('/:id', auth, async (req, res) => {
  const { baslik, aciklama, proje_yili, durum, konum, sira } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE insaatlar
       SET baslik=$1, aciklama=$2, proje_yili=$3, durum=$4, konum=$5,
           sira=COALESCE($6, sira), updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [baslik, aciklama || null, parseInt(proje_yili), durum, konum || null, sira ?? null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bulunamadı' });
    res.json(rows[0]);
  } catch(e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

// İnşaat sil (fotograflar da silinir — ON DELETE CASCADE)
router.delete('/:id', auth, async (req, res) => {
  try {
    // Disk'teki dosyaları da sil
    const { rows } = await db.query(
      'SELECT fotograf_path FROM insaat_fotograflar WHERE insaat_id=$1', [req.params.id]
    );
    for (const r of rows) {
      const fp = path.join(__dirname, '../public', r.fotograf_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await db.query('DELETE FROM insaatlar WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

/* ── Fotoğraf yükle (max 5 adet) ── */
router.post('/:id/fotograflar', auth, upload.array('fotograflar', 5), async (req, res) => {
  try {
    const insaatId = req.params.id;
    // Mevcut fotoğraf sayısını kontrol et
    const { rows: existing } = await db.query(
      'SELECT COUNT(*) AS cnt FROM insaat_fotograflar WHERE insaat_id=$1', [insaatId]
    );
    const mevcutSayi = parseInt(existing[0].cnt);
    if (mevcutSayi >= 5) {
      // Yüklenen dosyaları temizle
      for (const f of req.files) fs.unlinkSync(f.path);
      return res.status(400).json({ error: 'En fazla 5 fotoğraf yüklenebilir.' });
    }
    const kalanSlot = 5 - mevcutSayi;
    const yuklenecek = req.files.slice(0, kalanSlot);
    // Fazla dosyaları temizle
    for (const f of req.files.slice(kalanSlot)) fs.unlinkSync(f.path);

    const eklenenler = [];
    for (let i = 0; i < yuklenecek.length; i++) {
      const webPath = `/uploads/insaat/${path.basename(yuklenecek[i].path)}`;
      const { rows } = await db.query(
        `INSERT INTO insaat_fotograflar (insaat_id, fotograf_path, sira)
         VALUES ($1, $2, $3) RETURNING *`,
        [insaatId, webPath, mevcutSayi + i + 1]
      );
      eklenenler.push({ id: rows[0].id, url: webPath, sira: rows[0].sira });
    }
    res.status(201).json({ eklenen: eklenenler.length, fotograflar: eklenenler });
  } catch(e) {
    if (req.files) for (const f of req.files) { try { fs.unlinkSync(f.path); } catch {} }
    res.status(500).json({ error: "İşlem başarısız oldu." });
  }
});

/* ── Fotoğraf sil ── */
router.delete('/:id/fotograflar/:fotoId', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT fotograf_path FROM insaat_fotograflar WHERE id=$1 AND insaat_id=$2',
      [req.params.fotoId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Fotoğraf bulunamadı' });
    const fp = path.join(__dirname, '../public', rows[0].fotograf_path);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    await db.query('DELETE FROM insaat_fotograflar WHERE id=$1', [req.params.fotoId]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

module.exports = router;
