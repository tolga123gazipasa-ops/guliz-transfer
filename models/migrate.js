require('dotenv').config();
const pool   = require('./db');
const bcrypt = require('bcryptjs');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('📦 Tablolar oluşturuluyor...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        email      VARCHAR(150) UNIQUE NOT NULL,
        password   VARCHAR(255) NOT NULL,
        role       VARCHAR(20)  DEFAULT 'admin',
        created_at TIMESTAMPTZ  DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS drivers (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        phone      VARCHAR(20)  NOT NULL,
        plate      VARCHAR(20)  NOT NULL,
        status     VARCHAR(20)  DEFAULT 'available',
        created_at TIMESTAMPTZ  DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS transfer_routes (
        id         SERIAL PRIMARY KEY,
        from_point VARCHAR(150) NOT NULL,
        to_point   VARCHAR(150) NOT NULL,
        price      NUMERIC(10,2) NOT NULL,
        duration   VARCHAR(50),
        active     BOOLEAN DEFAULT TRUE,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id              SERIAL PRIMARY KEY,
        booking_ref     VARCHAR(20)  UNIQUE NOT NULL,
        customer_name   VARCHAR(100) NOT NULL,
        customer_phone  VARCHAR(20)  NOT NULL,
        customer_email  VARCHAR(150),
        from_point      VARCHAR(150) NOT NULL,
        to_point        VARCHAR(150) NOT NULL,
        transfer_date   DATE NOT NULL,
        transfer_time   TIME NOT NULL,
        passenger_count INTEGER      DEFAULT 1,
        flight_number   VARCHAR(20),
        price           NUMERIC(10,2) NOT NULL,
        status          VARCHAR(30)  DEFAULT 'pending',
        driver_id       INTEGER REFERENCES drivers(id),
        payment_status  VARCHAR(20)  DEFAULT 'unpaid',
        payment_id      VARCHAR(100),
        notes           TEXT,
        created_at      TIMESTAMPTZ  DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS payments (
        id           SERIAL PRIMARY KEY,
        booking_id   INTEGER REFERENCES bookings(id),
        amount       NUMERIC(10,2) NOT NULL,
        installment  INTEGER DEFAULT 1,
        iyzico_token VARCHAR(255),
        status       VARCHAR(20) DEFAULT 'pending',
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_bookings_date   ON bookings(transfer_date);
      CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
      CREATE INDEX IF NOT EXISTS idx_bookings_ref    ON bookings(booking_ref);

      CREATE TABLE IF NOT EXISTS users (
        id               SERIAL PRIMARY KEY,
        name             VARCHAR(100) NOT NULL,
        email            VARCHAR(150) UNIQUE NOT NULL,
        phone            VARCHAR(20)  UNIQUE NOT NULL,
        password         VARCHAR(255) NOT NULL,
        phone_verified   BOOLEAN      DEFAULT FALSE,
        otp_code         VARCHAR(6),
        otp_expires_at   TIMESTAMPTZ,
        created_at       TIMESTAMPTZ  DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
    `);

    await client.query(`
      INSERT INTO transfer_routes (from_point, to_point, price, duration) VALUES
        ('Gazipaşa Havalimanı (GZP)', 'Alanya Merkez',    650,  '25-35 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Alanya Mahmutlar', 750,  '35-45 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Alanya Oba',       700,  '30-40 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Alanya Kestel',    720,  '30-40 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Alanya Avsallar',  800,  '40-50 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Gazipaşa Merkez',  400,  '10-15 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Side',             950,  '60-75 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Manavgat',         900,  '55-70 dk'),
        ('Gazipaşa Havalimanı (GZP)', 'Antalya Merkez',   1350, '90-110 dk')
      ON CONFLICT DO NOTHING;
    `);

    const hash = await bcrypt.hash('Guliz2025!', 12);
    await client.query(`
      INSERT INTO admins (name, email, password, role)
      VALUES ('Süper Admin', 'admin@guliztransfer.com', $1, 'superadmin')
      ON CONFLICT DO NOTHING;
    `, [hash]);

    console.log('');
    console.log('✅ Veritabanı hazır!');
    console.log('👤 Admin giriş: admin@guliztransfer.com / Guliz2025!');
    console.log('⚠️  İlk girişten sonra şifreyi değiştirin!');
  } catch(e) {
    console.error('❌ Hata:', e.message);
    console.error('💡 .env dosyasındaki DB_PASSWORD doğru mu kontrol edin.');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
