require('dotenv').config();

/* Desteklenen sağlayıcılar: twilio | netgsm */
const PROVIDER = process.env.SMS_PROVIDER || 'twilio';

async function sendSms(to, message) {
  if (!process.env.SMS_PROVIDER) {
    console.log(`[SMS - DEV] To: ${to} | Msg: ${message}`);
    return;
  }

  if (PROVIDER === 'twilio') {
    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_TOKEN);
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_FROM,
      to,
    });

  } else if (PROVIDER === 'netgsm') {
    // NetGSM HTTP API (Türkiye)
    const url = 'https://api.netgsm.com.tr/sms/send/get/';
    const phone = to.replace(/^\+90/, '').replace(/\D/g, '');
    const params = new URLSearchParams({
      usercode: process.env.NETGSM_USER,
      password:  process.env.NETGSM_PASS,
      gsmno:     phone,
      message,
      msgheader: process.env.NETGSM_HEADER || 'GULIZ',
    });
    const res = await fetch(`${url}?${params}`);
    const body = await res.text();
    if (!body.startsWith('00') && !body.startsWith('01')) {
      throw new Error(`NetGSM hata: ${body}`);
    }
  }
}

/* 6 haneli OTP üret ve gönder */
async function sendOtp(phone, code) {
  const msg = `Guliz Transfer dogrulama kodunuz: ${code}. Bu kodu kimseyle paylasmayiniz. Gecerlilik: 10 dakika.`;
  await sendSms(phone, msg);
}

/* Yöneticiye yeni rezervasyon SMS bildirimi */
async function notifyAdminSms(message) {
  const adminPhone = process.env.ADMIN_NOTIFY_PHONE;
  if (!adminPhone) return;
  await sendSms(adminPhone, message);
}

module.exports = { sendSms, sendOtp, notifyAdminSms };
