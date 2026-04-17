/**
 * tracker.js — Güliz Gelişmiş Ziyaretçi Takip Modülü
 * Rage click · Exit intent · Form capture · rrweb replay · Funnel · Lead score
 */
(function () {
  'use strict';

  const SESSION_KEY = 'gt_chat_session';
  let sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = 'v_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
    localStorage.setItem(SESSION_KEY, sessionId);
  }

  const _queue = [];
  let _socket   = null;
  let _rrwebStop = null;

  function getSocket() {
    try { if (typeof chatSocket !== 'undefined' && chatSocket) return chatSocket; } catch (_) {}
    return _socket;
  }

  function rawEmit(event, data) {
    const s = getSocket();
    if (s && s.connected) {
      s.emit(event, data);
    } else {
      _queue.push({ event, data });
    }
  }

  function action(act, detail) {
    rawEmit('visitor:action', { sessionId, action: act, detail });
  }

  function flushQueue(s) {
    while (_queue.length) {
      const item = _queue.shift();
      s.emit(item.event, item.data);
    }
  }

  /* ══════════════════════════════════════
     1. RAGE CLICK — aynı elemente 3+ tıklama
  ══════════════════════════════════════ */
  let _rage = { el: null, count: 0, t: 0 };

  document.addEventListener('click', function (e) {
    const now = Date.now();
    const el  = e.target;

    // Rage click tespiti
    if (_rage.el === el && now - _rage.t < 700) {
      _rage.count++;
      if (_rage.count === 3) {
        const label = (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 60);
        rawEmit('visitor:rage_click', { sessionId, element: label, page: location.pathname });
      }
    } else {
      _rage = { el, count: 1, t: now };
    }

    // Normal click kaydı
    const btn = el.closest('a, button, [role="button"], input[type="submit"], input[type="button"]');
    if (!btn || btn.closest('.chat-box, #chatInputRow, .chat-btn')) return;
    const text   = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const href   = (btn.href || btn.getAttribute('href') || '').replace(location.origin, '').slice(0, 60);
    const isNav  = !!btn.closest('nav, .nav, header');
    const detail = [text, (!isNav && href) ? '→ ' + href : ''].filter(Boolean).join(' ').slice(0, 120);
    action(isNav ? 'nav_click' : 'click', detail || btn.tagName);
  }, true);

  /* ══════════════════════════════════════
     2. EXIT INTENT — mouse üst kenara
  ══════════════════════════════════════ */
  let _exitFired = false;
  document.addEventListener('mouseleave', function (e) {
    if (e.clientY < 10 && !_exitFired) {
      _exitFired = true;
      rawEmit('visitor:exit_intent', { sessionId, page: location.href });
      setTimeout(function () { _exitFired = false; }, 30000);
    }
  });

  /* ══════════════════════════════════════
     3. SCROLL DERİNLİĞİ
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
          action('scroll', m.toString());
        }
      });
    });
  }, { passive: true });

  /* ══════════════════════════════════════
     4. FORM ALAN YAKALAMA — blur'da değer
  ══════════════════════════════════════ */
  document.addEventListener('blur', function (e) {
    const el = e.target;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
    if (el.type === 'password') return;
    if (el.closest('.chat-box, #chatInputRow, #chatMsgInput, .admin-input-row')) return;

    const label = (
      el.closest('.form-group, .field-wrap, .booking-field, .input-group')
        ?.querySelector('label')?.textContent?.trim() ||
      el.placeholder || el.name || el.id || el.tagName
    ).slice(0, 50);

    const val = el.tagName === 'SELECT'
      ? (el.options[el.selectedIndex]?.text || el.value)
      : el.value.trim().slice(0, 100);
    if (!val) return;

    const isPhone = /tel|phone|gsm|cep/i.test(label + el.type + (el.name || ''));
    const isName  = /isim|^ad |ad$|name|soyad/i.test(label);

    rawEmit('visitor:form_field', { sessionId, label, value: val, isPhone, isName, page: location.pathname });
    action('form_fill', label + ': ' + val.slice(0, 40));
  }, true);

  /* ══════════════════════════════════════
     5. FUNNEL ADIMLAR — section görünürlüğü
  ══════════════════════════════════════ */
  const FUNNEL_MAP = {
    '#rezervasyon':       'form_open',
    '#fiyatlar':          'pricing_view',
    '#hizmetler':         'services_view',
    '.booking-form':      'form_open',
    '#bookingSection':    'form_open',
    '#transfer-section':  'transfer_section',
    '.price-card':        'pricing_view',
    '#odeme':             'payment_page',
  };

  if (window.IntersectionObserver) {
    const funnelObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        for (const sel in FUNNEL_MAP) {
          if (entry.target.matches(sel)) {
            rawEmit('visitor:funnel', { sessionId, step: FUNNEL_MAP[sel], page: location.pathname });
            funnelObserver.unobserve(entry.target);
            break;
          }
        }
      });
    }, { threshold: 0.3 });

    const tryObserveFunnel = function () {
      Object.keys(FUNNEL_MAP).forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (el) {
          funnelObserver.observe(el);
        });
      });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryObserveFunnel);
    } else {
      tryObserveFunnel();
    }
  }

  // Sayfa başlangıcında funnel adımını belirle
  const pagePath = location.pathname;
  if (pagePath.includes('/transfer')) rawEmit('visitor:funnel', { sessionId, step: 'service_page', page: pagePath });
  else if (pagePath === '/' || pagePath === '/index.html') rawEmit('visitor:funnel', { sessionId, step: 'homepage', page: pagePath });
  else if (pagePath.includes('/lojistik')) rawEmit('visitor:funnel', { sessionId, step: 'service_page', page: pagePath });

  /* ══════════════════════════════════════
     6. RRWEB KAYIT — session replay
  ══════════════════════════════════════ */
  function startRrweb() {
    if (!window.rrweb || _rrwebStop) return;
    try {
      _rrwebStop = rrweb.record({
        emit: function (event) {
          rawEmit('visitor:rrweb', { sessionId, event });
        },
        sampling: {
          mousemove : 100,
          scroll    : 150,
          input     : 'last',
        },
        maskInputOptions : { password: true },
        blockClass       : 'rr-block',
        checkoutEveryNth : 60,
      });
    } catch (err) { /* rrweb desteklenmiyorsa sessizce geç */ }
  }

  function loadRrweb() {
    if (window.rrweb && window.rrweb.record) { startRrweb(); return; }
    const s = document.createElement('script');
    // Sadece stabil v1 — player ile uyumlu
    s.src = 'https://cdn.jsdelivr.net/npm/rrweb@1.1.3/dist/rrweb.min.js';
    s.onload = startRrweb;
    s.onerror = function () {
      // Fallback: unpkg
      const s2 = document.createElement('script');
      s2.src = 'https://unpkg.com/rrweb@1.1.3/dist/rrweb.min.js';
      s2.onload = startRrweb;
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  }

  /* ══════════════════════════════════════
     7. SOCKET BAĞLANTISI
  ══════════════════════════════════════ */
  function connectOwnSocket() {
    if (typeof io === 'undefined') return;
    _socket = io({ transports: ['websocket', 'polling'] });
    _socket.on('connect', function () {
      _socket.emit('visitor:connect', {
        sessionId,
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
    const s = getSocket();
    if (s) {
      const afterConnect = function () { flushQueue(s); loadRrweb(); };
      if (s.connected) afterConnect();
      else s.on('connect', afterConnect);
      return;
    }
    if (typeof io !== 'undefined') {
      connectOwnSocket();
      loadRrweb();
    } else {
      const script = document.createElement('script');
      script.src = '/socket.io/socket.io.js';
      script.onload = function () { connectOwnSocket(); loadRrweb(); };
      document.head.appendChild(script);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(tryConnect, 150); });
  } else {
    setTimeout(tryConnect, 150);
  }
})();
