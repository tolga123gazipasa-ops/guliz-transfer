require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM = `"Güliz Transfer" <${process.env.SMTP_USER}>`;

/* Hoş geldin e-postası */
async function sendWelcomeEmail(user) {
  if (!process.env.SMTP_USER) return;
  await transporter.sendMail({
    from: FROM,
    to:   user.email,
    subject: 'Güliz Transfer — Hoş Geldiniz!',
    html: `
    <div style="font-family:Georgia,serif;background:#0a0a0a;color:#fff;padding:40px;max-width:560px;margin:0 auto;">
      <h2 style="color:#C9A84C;font-size:22px;margin-bottom:8px;">Güliz Transfer</h2>
      <p style="color:rgba(255,255,255,0.4);font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">VIP Vito Transfer Hizmeti</p>
      <h3 style="font-size:18px;margin-bottom:16px;">Merhaba ${user.name},</h3>
      <p style="color:rgba(255,255,255,0.7);line-height:1.7;margin-bottom:24px;">
        Güliz Transfer ailesine hoş geldiniz! Hesabınız başarıyla oluşturuldu.<br>
        Artık rezervasyonlarınızı daha hızlı yapabilir ve geçmiş transferlerinizi takip edebilirsiniz.
      </p>
      <div style="background:rgba(201,168,76,0.08);border:0.5px solid rgba(201,168,76,0.2);padding:16px 20px;margin-bottom:24px;">
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.5);">Hesap e-postanız: <strong style="color:#fff;">${user.email}</strong></p>
      </div>
      <p style="font-size:12px;color:rgba(255,255,255,0.3);">Şüpheli bir işlem olduğunu düşünüyorsanız hemen bizimle iletişime geçin.</p>
      <hr style="border:none;border-top:0.5px solid rgba(255,255,255,0.08);margin:24px 0;">
      <p style="font-size:11px;color:rgba(255,255,255,0.2);text-align:center;">© 2025 Güliz Transfer — Güliz Şirketler Grubu</p>
    </div>`,
  });
}

/* SMS OTP için e-posta yedekleme (SMS servisi yoksa) */
async function sendOtpEmail(user, code) {
  if (!process.env.SMTP_USER) return;
  await transporter.sendMail({
    from: FROM,
    to:   user.email,
    subject: `Güliz Transfer — Doğrulama Kodu: ${code}`,
    html: `
    <div style="font-family:Georgia,serif;background:#0a0a0a;color:#fff;padding:40px;max-width:560px;margin:0 auto;">
      <h2 style="color:#C9A84C;">Güliz Transfer</h2>
      <h3 style="margin:24px 0 16px;">Doğrulama Kodunuz</h3>
      <div style="background:rgba(201,168,76,0.08);border:0.5px solid rgba(201,168,76,0.3);padding:24px;text-align:center;margin-bottom:24px;">
        <span style="font-family:monospace;font-size:32px;letter-spacing:10px;color:#C9A84C;">${code}</span>
      </div>
      <p style="color:rgba(255,255,255,0.5);font-size:13px;">Bu kod 10 dakika geçerlidir. Talep etmediyseniz dikkate almayınız.</p>
    </div>`,
  });
}

/* Rezervasyon onay e-postası */
async function sendBookingConfirmation(user, booking) {
  if (!process.env.SMTP_USER) return;
  const emailTo = user.email || booking.customer_email;
  if (!emailTo) return;
  await transporter.sendMail({
    from: FROM,
    to:   emailTo,
    subject: `Güliz Transfer — Rezervasyon Onayı ${booking.booking_ref}`,
    html: `
    <div style="font-family:Georgia,serif;background:#0a0a0a;color:#fff;padding:40px;max-width:560px;margin:0 auto;">
      <h2 style="color:#C9A84C;margin-bottom:4px;">Güliz Transfer</h2>
      <p style="color:rgba(255,255,255,0.4);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">Rezervasyon Onayı</p>
      <h3 style="margin-bottom:20px;">Merhaba ${user.name || booking.customer_name},</h3>
      <p style="color:rgba(255,255,255,0.7);margin-bottom:24px;">Rezervasyonunuz onaylanmıştır. Detaylar aşağıdadır:</p>
      <div style="background:rgba(201,168,76,0.06);border:0.5px solid rgba(201,168,76,0.2);padding:20px 24px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Rezervasyon No</td><td style="color:#C9A84C;font-family:monospace;text-align:right;">${booking.booking_ref}</td></tr>
          <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Güzergah</td><td style="color:#fff;text-align:right;">${booking.from_point} → ${booking.to_point}</td></tr>
          <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Tarih & Saat</td><td style="color:#fff;text-align:right;">${booking.transfer_date} ${booking.transfer_time}</td></tr>
          <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Yolcu Sayısı</td><td style="color:#fff;text-align:right;">${booking.passenger_count} kişi</td></tr>
          <tr style="border-top:0.5px solid rgba(201,168,76,0.15);">
            <td style="color:#C9A84C;padding:10px 0 0;font-size:14px;">Toplam Tutar</td>
            <td style="color:#C9A84C;text-align:right;font-size:18px;padding-top:10px;">₺${parseInt(booking.price).toLocaleString('tr-TR')}</td>
          </tr>
        </table>
      </div>
      <p style="color:rgba(255,255,255,0.5);font-size:13px;line-height:1.7;">Sürücünüz transfer saatinden <strong style="color:#fff;">30 dakika önce</strong> sizi arayacaktır. Sorularınız için WhatsApp hattımıza yazabilirsiniz.</p>
    </div>`,
  });
}

/* Yöneticiye yeni rezervasyon bildirimi */
async function notifyAdminNewBooking(booking) {
  const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || process.env.SMTP_USER;
  if (!adminEmail || !process.env.SMTP_USER) return;
  await transporter.sendMail({
    from: FROM,
    to:   adminEmail,
    subject: `[YENİ REZERVASYON] ${booking.booking_ref} — ${booking.customer_name}`,
    html: `
    <div style="font-family:Georgia,serif;background:#0a0a0a;color:#fff;padding:32px;max-width:540px;">
      <h2 style="color:#C9A84C;margin-bottom:4px;">Güliz Transfer</h2>
      <p style="color:rgba(255,255,255,0.4);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:24px;">Yeni Rezervasyon Bildirimi</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Rezervasyon No</td><td style="color:#C9A84C;font-family:monospace;">${booking.booking_ref}</td></tr>
        <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Müşteri</td><td style="color:#fff;">${booking.customer_name}</td></tr>
        <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Telefon</td><td style="color:#fff;">${booking.customer_phone}</td></tr>
        <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Güzergah</td><td style="color:#fff;">${booking.from_point} → ${booking.to_point}</td></tr>
        <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Tarih & Saat</td><td style="color:#fff;">${booking.transfer_date} ${booking.transfer_time}</td></tr>
        <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Tutar</td><td style="color:#C9A84C;font-size:16px;">₺${parseInt(booking.price).toLocaleString('tr-TR')}</td></tr>
      </table>
      <p style="margin-top:20px;font-size:12px;color:rgba(255,255,255,0.3);">Admin panelinden onaylayın: <a href="http://localhost:3001/admin.html" style="color:#C9A84C;">Admin Panel</a></p>
    </div>`,
  });
}

/* Yöneticiye yeni üyelik bildirimi */
async function notifyAdminNewUser(user) {
  const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || process.env.SMTP_USER;
  if (!adminEmail || !process.env.SMTP_USER) return;
  await transporter.sendMail({
    from: FROM,
    to:   adminEmail,
    subject: `[YENİ ÜYE] ${user.name} — ${user.email}`,
    html: `
    <div style="font-family:Georgia,serif;background:#0a0a0a;color:#fff;padding:32px;max-width:540px;">
      <h2 style="color:#C9A84C;margin-bottom:4px;">Güliz Transfer</h2>
      <p style="color:rgba(255,255,255,0.4);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:24px;">Yeni Üyelik Kaydı</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Ad Soyad</td><td style="color:#fff;">${user.name}</td></tr>
        <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">E-posta</td><td style="color:#fff;">${user.email}</td></tr>
        <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Telefon</td><td style="color:#fff;">${user.phone}</td></tr>
        <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Kayıt Tarihi</td><td style="color:#fff;">${new Date().toLocaleString('tr-TR')}</td></tr>
      </table>
    </div>`,
  });
}

/* Yöneticiye yeni ödeme bildirimi */
async function notifyAdminPayment(booking, amount) {
  const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || process.env.SMTP_USER;
  if (!adminEmail || !process.env.SMTP_USER) return;
  await transporter.sendMail({
    from: FROM,
    to:   adminEmail,
    subject: `[ÖDEME ALINDI] ${booking.booking_ref} — ₺${parseInt(amount).toLocaleString('tr-TR')}`,
    html: `
    <div style="font-family:Georgia,serif;background:#0a0a0a;color:#fff;padding:32px;max-width:540px;">
      <h2 style="color:#C9A84C;margin-bottom:4px;">Güliz Transfer</h2>
      <p style="color:rgba(255,255,255,0.4);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:24px;">Ödeme Bildirimi</p>
      <div style="background:rgba(34,197,94,0.08);border:0.5px solid rgba(34,197,94,0.2);padding:16px 20px;margin-bottom:20px;text-align:center;">
        <div style="font-size:28px;color:#4ade80;font-family:Georgia,serif;">₺${parseInt(amount).toLocaleString('tr-TR')}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.3);letter-spacing:1px;text-transform:uppercase;margin-top:4px;">Ödeme Başarıyla Alındı</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Rezervasyon No</td><td style="color:#C9A84C;font-family:monospace;">${booking.booking_ref}</td></tr>
        <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Müşteri</td><td style="color:#fff;">${booking.customer_name}</td></tr>
        <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Güzergah</td><td style="color:#fff;">${booking.from_point} → ${booking.to_point}</td></tr>
        <tr><td style="color:rgba(255,255,255,0.4);padding:6px 0;">Tarih</td><td style="color:#fff;">${booking.transfer_date}</td></tr>
      </table>
    </div>`,
  });
}

module.exports = { sendWelcomeEmail, sendOtpEmail, sendBookingConfirmation, notifyAdminNewBooking, notifyAdminNewUser, notifyAdminPayment };
