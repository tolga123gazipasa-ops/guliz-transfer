/* ── Gerçek ziyaretçi IP'sini güvenilir şekilde tespit eden yardımcılar ──
 * Neden gerekli: Railway/Cloudflare gibi proxy'lerin arkasında çalışırken
 * "::ffff:1.2.3.4" gibi IPv4-mapped IPv6 adresleri veya proxy'nin kendi
 * private IP'si sızabiliyor. Bunlar ip-api.com'a olduğu gibi gönderilince
 * yanlış (genelde yurt dışı) konum sonucu dönüyor. Bu modül:
 *   1) IPv4-mapped IPv6 önekini ("::ffff:") temizler,
 *   2) Cloudflare kullanılıyorsa CF-Connecting-IP başlığını önceliklendirir,
 *   3) Private/rezerve IP aralıklarını (10.x, 172.16-31.x, 192.168.x,
 *      169.254.x, loopback, link-local IPv6, unique-local IPv6) tanır —
 *      bunlar asla ip-api.com'a gönderilmemeli.
 */

function normalizeIp(ip) {
  if (!ip) return '';
  ip = String(ip).trim();
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  return m ? m[1] : ip;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true; // 172.16.0.0/12
  if (/^169\.254\./.test(ip)) return true;                  // link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;           // fc00::/7 (unique local)
  if (/^fe80:/i.test(ip)) return true;                       // link-local IPv6
  return false;
}

/**
 * Express req.headers veya socket.handshake.headers gibi bir headers
 * nesnesinden gerçek istemci IP'sini çıkarır.
 * @param {object} headers  - istek header'ları (lowercase key bekler)
 * @param {string} fallback - header yoksa kullanılacak adres (req.ip / socket.handshake.address vb.)
 */
function extractClientIp(headers, fallback) {
  headers = headers || {};
  const cf  = headers['cf-connecting-ip'];
  const xff = headers['x-forwarded-for'];
  const raw = cf || (xff ? String(xff).split(',')[0].trim() : '') || fallback || '';
  return normalizeIp(raw);
}

module.exports = { normalizeIp, isPrivateIp, extractClientIp };
