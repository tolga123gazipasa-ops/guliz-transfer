/**
 * consent-banner.js — KVKK / çerez bilgilendirme şeridi
 * Tüm ziyaretçi sayfalarında ortak kullanılır. Tek bir yerden güncellenir.
 */
(function () {
  'use strict';
  var KEY = 'gt_consent_v1';
  try {
    if (localStorage.getItem(KEY) === '1') return;
  } catch (e) { /* localStorage kapalıysa şeridi yine göster, sorun değil */ }

  function inject() {
    var bar = document.createElement('div');
    bar.id = 'gtConsentBar';
    bar.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:99999',
      'background:#0a1235', 'color:#fff',
      'padding:14px 20px', 'display:flex', 'flex-wrap:wrap',
      'align-items:center', 'justify-content:center', 'gap:16px',
      'font-family:Montserrat,Arial,sans-serif', 'font-size:13px',
      'box-shadow:0 -4px 24px rgba(0,0,0,0.25)'
    ].join(';');

    var text = document.createElement('span');
    text.style.cssText = 'color:rgba(255,255,255,0.85);max-width:640px;line-height:1.6;';
    text.innerHTML = '🍪 Sitemizde deneyiminizi iyileştirmek ve hizmet kalitemizi artırmak için çerezler kullanıyoruz. Detaylar için ' +
      '<a href="/gizlilik-politikasi/" style="color:#ff8a95;text-decoration:underline;">Gizlilik Politikası</a> sayfamızı inceleyebilirsiniz.';

    var btn = document.createElement('button');
    btn.textContent = 'Anladım, Kabul Ediyorum';
    btn.style.cssText = [
      'background:#e8192c', 'color:#fff', 'border:none', 'border-radius:24px',
      'padding:10px 22px', 'font-size:12px', 'font-weight:700', 'letter-spacing:0.5px',
      'cursor:pointer', 'white-space:nowrap', 'font-family:inherit'
    ].join(';');
    btn.onmouseover = function () { btn.style.background = '#b01020'; };
    btn.onmouseout  = function () { btn.style.background = '#e8192c'; };
    btn.onclick = function () {
      try { localStorage.setItem(KEY, '1'); } catch (e) {}
      bar.remove();
    };

    bar.appendChild(text);
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
