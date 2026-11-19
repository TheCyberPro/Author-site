// public/site.js — shared behaviour for every page
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* sticky header state */
  const header = $('#siteHeader');
  if (header) {
    const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* mobile nav */
  const navToggle = $('#navToggle');
  const siteNav = $('#siteNav');
  const closeNav = () => {
    if (!siteNav) return;
    siteNav.classList.remove('open');
    if (navToggle) { navToggle.classList.remove('open'); navToggle.setAttribute('aria-expanded', 'false'); }
  };
  if (navToggle && siteNav) {
    navToggle.addEventListener('click', () => {
      const open = siteNav.classList.toggle('open');
      navToggle.classList.toggle('open', open);
      navToggle.setAttribute('aria-expanded', String(open));
    });
    siteNav.addEventListener('click', e => { if (e.target.closest('a')) closeNav(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNav(); });
    document.addEventListener('click', e => { if (siteNav.classList.contains('open') && !e.target.closest('.header-inner')) closeNav(); });
  }

  /* toasts */
  const toastWrap = $('#toasts');
  const dismissToast = t => { t.classList.add('out'); setTimeout(() => t.remove(), 260); };
  const bindToast = t => {
    const ttl = parseInt(t.dataset.ttl, 10) || 5200;
    let timer = setTimeout(() => dismissToast(t), ttl);
    t.addEventListener('mouseenter', () => clearTimeout(timer));
    t.addEventListener('mouseleave', () => { timer = setTimeout(() => dismissToast(t), 2500); });
    const x = t.querySelector('[data-toast-close]');
    if (x) x.addEventListener('click', () => dismissToast(t));
  };
  $$('[data-toast]').forEach(bindToast);
  window.showToast = (text, type = 'info') => {
    if (!toastWrap) return;
    const t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.setAttribute('data-toast', '');
    t.dataset.ttl = '4200';
    t.innerHTML = '<span class="toast-dot"></span><div class="toast-msg"></div><button class="toast-close" data-toast-close aria-label="Dismiss">\u00d7</button>';
    t.querySelector('.toast-msg').textContent = text;
    toastWrap.appendChild(t);
    bindToast(t);
  };

  /* scroll reveals */
  const revealEls = $$('.reveal');
  if (revealEls.length) {
    if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      revealEls.forEach(el => el.classList.add('in'));
    } else {
      const io = new IntersectionObserver(entries => {
        entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
      }, { threshold: 0.08, rootMargin: '0px 0px -8% 0px' });
      revealEls.forEach(el => io.observe(el));
    }
  }

  /* reading progress */
  const prog = $('#progress');
  if (prog) {
    let ticking = false;
    const update = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      prog.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, window.scrollY / max) : 0) + ')';
      ticking = false;
    };
    update();
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    window.addEventListener('resize', update);
  }

  /* copy link */
  $$('[data-copy-link]').forEach(btn => btn.addEventListener('click', async () => {
    const url = location.href.split('#')[0];
    try { await navigator.clipboard.writeText(url); window.showToast('Link copied to clipboard.', 'ok'); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); window.showToast('Link copied.', 'ok'); }
      catch (e2) { window.showToast(url, 'info'); }
      ta.remove();
    }
  }));

  /* graceful cover fallback */
  $$('img[data-cover-fallback]').forEach(img => {
    img.addEventListener('error', () => {
      const fb = document.createElement('div');
      fb.className = img.dataset.fbClass || 'book-cover cover-fallback';
      const t = document.createElement('span');
      t.textContent = img.dataset.title || 'Untitled';
      fb.appendChild(t);
      img.replaceWith(fb);
    }, { once: true });
  });

  /* password visibility */
  $$('[data-toggle-password]').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.togglePassword);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      input.focus();
    });
  });

  /* newsletter signup */
  $$('form[data-newsletter]').forEach(form => {
    const note = form.parentElement.querySelector('[data-letter-note]');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      const emailInput = form.querySelector('input[name="email"]');
      if (!emailInput.value.trim()) { emailInput.focus(); return; }
      const oldLabel = btn.textContent;
      btn.disabled = true; btn.textContent = 'Subscribing\u2026';
      try {
        const resp = await fetch(form.action, {
          method: 'POST',
          headers: { 'Accept': 'application/json' },
          body: new URLSearchParams(new FormData(form))
        });
        const data = await resp.json();
        if (data.ok) {
          const done = document.createElement('p');
          done.className = 'letter-done';
          done.setAttribute('role', 'status');
          done.textContent = data.message;
          form.replaceWith(done);
          if (note) note.hidden = true;
        } else {
          if (note) { note.textContent = data.message; note.classList.add('error'); note.hidden = false; }
          btn.disabled = false; btn.textContent = oldLabel;
        }
      } catch (err) {
        if (note) { note.textContent = 'Something went wrong \u2014 please try again.'; note.classList.add('error'); }
        btn.disabled = false; btn.textContent = oldLabel;
      }
    });
  });
})();
