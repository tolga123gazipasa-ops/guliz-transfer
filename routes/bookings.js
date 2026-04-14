const router = require('express').Router();
const db     = require('../models/db');
const auth   = require('../middleware/auth');
const { notifyAdminNewBooking, sendBookingConfirmation } = require('../services/email');
const { notifyAdminSms } = require('../services/sms');
const { tgNewBooking, tgPayment } = require('../services/telegram');

function genRef() { return 'GT-' + Math.floor(100000 + Math.random() * 900000); }

router.get('/', auth, async (req, res) => {
  const { status, date, search } = req.query;
  let q = `SELECT b.*, d.name as driver_name, d.phone as driver_phone, d.plate
           FROM bookings b LEFT JOIN drivers d ON b.driver_id=d.id WHERE 1=1`;
  const p = [];
  if (status) { p.push(status); q += ` AND b.status=$${p.length}`; }
  if (date)   { p.push(date);   q += ` AND b.transfer_date=$${p.length}`; }
  if (search) {
    p.push('%'+search+'%');
    q += ` AND (b.customer_name ILIKE $${p.length} OR b.booking_ref ILIKE $${p.length} OR b.customer_phone ILIKE $${p.length})`;
  }
  q += ' ORDER BY b.created_at DESC';
  try { const { rows } = await db.query(q, p); res.json(rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT b.*, d.name as driver_name, d.phone as driver_phone, d.plate
       FROM bookings b LEFT JOIN drivers d ON b.driver_id=d.id WHERE b.id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Bulunamadı' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Public endpoint — müşteri sitesinden rezervasyon
router.post('/', async (req, res) => {
  const { customer_name, customer_phone, customer_email,
          from_point, to_point, transfer_date, transfer_time,
          passenger_count, flight_number, price, notes, status } = req.body;
  try {
    let ref, exists = true;
    while (exists) {
      ref = genRef();
      const r = await db.query('SELECT id FROM bookings WHERE booking_ref=$1', [ref]);
      exists = r.rows.length > 0;
    }
    const bookingStatus = status || 'pending';
    const { rows } = await db.query(`
      INSERT INTO bookings
        (booking_ref,customer_name,customer_phone,customer_email,
         from_point,to_point,transfer_date,transfer_time,
         passenger_count,flight_number,price,notes,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [ref, customer_name, customer_phone, customer_email||null,
       from_point, to_point, transfer_date, transfer_time,
       passenger_count||1, flight_number||null, price, notes||null, bookingStatus]);
    const booking = rows[0];
    // Admin bildirimleri
    notifyAdminNewBooking(booking).catch(() => {});
    notifyAdminSms(`[GULIZ] Yeni rezervasyon: ${ref} | ${customer_name} | ${from_point.replace('Gazipaşa Havalimanı (GZP)','GZP')} -> ${to_point} | ${transfer_date} ${transfer_time}`).catch(() => {});
    tgNewBooking(booking).catch(() => {});
    // Müşteri onay maili
    sendBookingConfirmation({ name: customer_name, email: customer_email }, booking).catch(() => {});
    res.status(201).json(booking);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ödeme kaydet — public endpoint (iyzico callback gibi)
router.post('/:id/payment', async (req, res) => {
  const { amount, installment, iyzico_token } = req.body;
  try {
    const { rows: br } = await db.query('SELECT * FROM bookings WHERE id=$1', [req.params.id]);
    if (!br.length) return res.status(404).json({ error: 'Rezervasyon bulunamadı' });
    const booking = br[0];
    await db.query(
      `INSERT INTO payments (booking_id, amount, installment, iyzico_token, status)
       VALUES ($1,$2,$3,$4,'completed')`,
      [req.params.id, amount || booking.price, installment || 1, iyzico_token || null]
    );
    await db.query(`UPDATE bookings SET payment_status='paid', status='confirmed' WHERE id=$1`, [req.params.id]);
    // Admin bildirimleri
    const { notifyAdminPayment } = require('../services/email');
    notifyAdminPayment(booking, amount || booking.price).catch(() => {});
    notifyAdminSms(`[GULIZ] ODEME ALINDI: ${booking.booking_ref} | ${booking.customer_name} | TL${parseInt(amount||booking.price).toLocaleString('tr-TR')}`).catch(() => {});
    tgPayment(booking, amount || booking.price).catch(() => {});
    res.json({ message: 'Ödeme kaydedildi', booking_ref: booking.booking_ref });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending','confirmed','assigned','completed','cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Geçersiz durum' });
  try {
    const { rows } = await db.query(
      'UPDATE bookings SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/assign', auth, async (req, res) => {
  const { driver_id } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE bookings SET driver_id=$1, status='assigned' WHERE id=$2 RETURNING *`,
      [driver_id, req.params.id]);
    await db.query("UPDATE drivers SET status='busy' WHERE id=$1", [driver_id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
