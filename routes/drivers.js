const router = require('express').Router();
const db     = require('../models/db');
const auth   = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
  try { const { rows } = await db.query('SELECT * FROM drivers ORDER BY name'); res.json(rows); }
  catch(e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

router.post('/', auth, async (req, res) => {
  const { name, phone, plate } = req.body;
  try {
    const { rows } = await db.query(
      'INSERT INTO drivers (name,phone,plate) VALUES ($1,$2,$3) RETURNING *', [name,phone,plate]);
    res.status(201).json(rows[0]);
  } catch(e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

router.put('/:id', auth, async (req, res) => {
  const { name, phone, plate, status } = req.body;
  try {
    const { rows } = await db.query(
      'UPDATE drivers SET name=$1,phone=$2,plate=$3,status=$4 WHERE id=$5 RETURNING *',
      [name,phone,plate,status,req.params.id]);
    res.json(rows[0]);
  } catch(e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

router.delete('/:id', auth, async (req, res) => {
  try { await db.query('DELETE FROM drivers WHERE id=$1', [req.params.id]); res.json({ message: 'Silindi' }); }
  catch(e) { console.error(e); res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

module.exports = router;
