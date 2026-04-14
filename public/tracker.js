/**
 * tracker.js — Güliz Şirketler Topluluğu
 * Evrensel ziyaretçi takip modülü.
 * Tüm sayfalara dahil edilir; click, scroll ve form doldurmayı izler.
 */
(function () {
  'use strict';

  /* ── SESSION ID ── */
  const SESSION_KEY = 'gt_chat_session';
  let sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = 'v_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
    localStorage.setItem(SESSION_KEY, sessionId);
  }

  /* ── KUYRUK (socket hazır olmadan önce gelen olaylar) ── */
  const _queue = [];
  let _socket  = null;

  /**
   * Mevcut sayfada chat widget'ının tanımladığı 'chatSocket'ı bul.
   * Yoksa tracker'ın kendi socketini (_socket) kullan.
   */
  function getSocket() {
    try {
      // chatSocket const olarak inline script'te tanımlı → doğrudan erişilebilir
      if (typeof chatSocket !== 'undefined' && chatSocket) return chatSocket;
    } catch (_) {}
    return _socket;
  }

  function emit(action, detail) {
    const s = getSocket();
    const data = { sessionId, action, detail };
    if (s && s.connected) {
      s.emit('visitor:action', data);
    } else {
      _queue.push(data);
    }
  }

  function flushQueue(s) {
    while (_queue.length) {
      s.emit('visitor:action', _queue.shift());
    }
  }

  /* ══════════════════════════════════════
     1. CLICK TAKİBİ
  ══════════════════════════════════════ */
  document.addEventListener('click', function (e) {
    const el = e.target.closest(
      'a, button, [role="button"], input[type="submit"], input[type="button"]'
    );
    if (!el) return;
    if (el.closest('.chat-box, .chat-btn, #chatInputRow')) return; // chat modülü kendi izliyor

    const text = (el.textContent || el.value || el.getAttribute('aria-label') || '')
      .trim().replace(/\s+/g, ' ').slice(0, 80);
    const href = (el.href || el.getAttribute('href') || '').replace(location.origin, '').slice(0, 60);
    const isNav = !!el.closest('nav');
    const detail = [text, (!isNav && href) ? '→ ' + href : ''].filter(Boolean).join(' ').trim() || el.tagName;

    emit(isNav ? 'nav_click' : 'click', detail.slice(0, 120));
  }, true);

  /* ══════════════════════════════════════
     2. SCROLL DERİNLİĞİ
  ══════════════════════════════════════ */
  const _scrollPassed = new Set();
  let   _rafPending   = false;

  window.addEventListener('scroll', function () {
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(function () {
      _rafPending = false;
      const pct = Math.round(
        ((window.scrollY + window.innerHeight) / document.documentElement.scrollHeight) * 100
      );
      [25, 50, 75, 100].forEach(function (m) {
        if (pct >= m && !_scrollPassed.has(m)) {
          _scrollPassed.add(m);
          emit('scroll', '%' + m + ' · ' + (document.title || location.pathname));
        }
      });
    });
  }, { passive: true });

  /* ══════════════════════════════════════
     3. FORM ALANI DOLDURMA (blur'da)
  ══════════════════════════════════════ */
  document.addEventListener('blur', function (e) {
    const el = e.target;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
    if (el.type === 'password') return; // Şifre asla izlenmiyor
    if (el.closest('.chat-box, #chatInputRow, #chatMsgInput')) return;

    const label = (el.placeholder || el.name || el.id || el.tagName).slice(0, 40);
    const val = el.tagName === 'SELECT'
      ? (el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : el.value)
      : el.value.trim().slice(0, 60);
    if (!val) return;

    emit('form_fill', label + ': ' + val);
  }, true);

  /* ══════════════════════════════════════
     4. SOCKET BAĞLANTISI
  ══════════════════════════════════════ */
  function connectOwnSocket() {
    if (typeof io === 'undefined') return;
    _socket = io({ transports: ['websocket', 'polling'] });
    _socket.on('connect', function () {
      _socket.emit('visitor:connect', {
        sessionId : sessionId,
        name      : 'Ziyaretçi',
        phone     : localStorage.getItem('gt_chat_phone') || '',
        page      : location.href,
        pageTitle : document.title,
        device    : /Mobile|Android|iPhone/i.test(navigator.userAgent) ? 'Mobil' : 'Masaüstü',
        referrer  : document.referrer || '',
      });
      flushQueue(_socket);
    });
  }

  function tryConnect() {
    // Önce mevcut chatSocket'ı kontrol et
    const s = getSocket();
    if (s) {
      if (s.connected) flushQueue(s);
      else s.on('connect', function () { flushQueue(s); });
      return;
    }
    // Yoksa kendi bağlantımızı aç
    if (typeof io !== 'undefined') {
      connectOwnSocket();
    } else {
      // socket.io henüz yüklenmediyse bir kez daha dene
      var script = document.createElement('script');
      script.src = '/socket.io/socket.io.js';
      script.onload = connectOwnSocket;
      document.head.appendChild(script);
    }
  }

  // DOM hazır olduktan sonra bağlan (chatSocket inline script'ten önce tanımlanmış olsun)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(tryConnect, 100); });
  } else {
    setTimeout(tryConnect, 100);
  }
})();
