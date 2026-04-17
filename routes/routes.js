const router = require('express').Router();
const db     = require('../models/db');
const auth   = require('../middleware/auth');

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM transfer_routes WHERE active=true ORDER BY price');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

router.post('/', auth, async (req, res) => {
  const { from_point, to_point, price, duration } = req.body;
  try {
    const { rows } = await db.query(
      'INSERT INTO transfer_routes (from_point,to_point,price,duration) VALUES ($1,$2,$3,$4) RETURNING *',
      [from_point,to_point,price,duration]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

router.put('/:id', auth, async (req, res) => {
  const { price, duration, active } = req.body;
  try {
    const { rows } = await db.query(
      'UPDATE transfer_routes SET price=$1,duration=$2,active=$3,updated_at=NOW() WHERE id=$4 RETURNING *',
      [price,duration,active,req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

module.exports = router;
