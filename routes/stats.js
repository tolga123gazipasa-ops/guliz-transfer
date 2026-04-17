const router = require('express').Router();
const db     = require('../models/db');
const auth   = require('../middleware/auth');

router.get('/dashboard', auth, async (req, res) => {
  try {
    const [total, today, revenue, pending, topRoutes] = await Promise.all([
      db.query("SELECT COUNT(*) FROM bookings WHERE status!='cancelled'"),
      db.query("SELECT COUNT(*) FROM bookings WHERE transfer_date=CURRENT_DATE AND status!='cancelled'"),
      db.query("SELECT COALESCE(SUM(price),0) as total FROM bookings WHERE payment_status='paid'"),
      db.query("SELECT COUNT(*) FROM bookings WHERE status='pending'"),
      db.query(`
        SELECT from_point||' → '||to_point as route, COUNT(*) as count, SUM(price) as revenue
        FROM bookings WHERE status!='cancelled'
        GROUP BY from_point,to_point ORDER BY count DESC LIMIT 5`),
    ]);
    res.json({
      totalBookings: parseInt(total.rows[0].count),
      todayBookings: parseInt(today.rows[0].count),
      totalRevenue:  parseFloat(revenue.rows[0].total),
      pendingCount:  parseInt(pending.rows[0].count),
      topRoutes:     topRoutes.rows,
    });
  } catch(e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

router.get('/monthly', auth, async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  try {
    const { rows } = await db.query(`
      SELECT TO_CHAR(transfer_date,'MM') as month,
             COUNT(*) as bookings,
             COALESCE(SUM(price),0) as revenue
      FROM bookings
      WHERE EXTRACT(YEAR FROM transfer_date)=$1 AND status!='cancelled'
      GROUP BY month ORDER BY month`, [year]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: "İşlem başarısız oldu." }); }
});

module.exports = router;
