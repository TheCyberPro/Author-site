// public/admin.js — the desk: editor, bulk actions, drag ordering, confirmations
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const toast = (m, t) => { if (window.showToast) window.showToast(m, t); };

  /* confirm dialog */
  const dlg = $('#confirmDialog');
  function askConfirm(text, label) {
    return new Promise(resolve => {
      if (!dlg || typeof dlg.showModal !== 'function') { resolve(window.confirm(text)); return; }
      $('#confirmText').textContent = text;
      $('#confirmYes').textContent = label || 'Delete';
      const onClose = () => { dlg.removeEventListener('close', onClose); resolve(dlg.returnValue === 'confirm'); };
      dlg.addEventListener('close', onClose);
      dlg.returnValue = 'cancel';
      dlg.showModal();
    });
  }
  if (dlg) dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close('cancel'); });
  $$('form[data-confirm]').forEach(form => {
    form.addEventListener('submit', async e => {
      if (form.dataset.confirmed === '1') { form.dataset.confirmed = ''; return; }
      e.preventDefault();
      const ok = await askConfirm(form.dataset.confirm, form.dataset.confirmLabel);
      if (ok) { form.dataset.confirmed = '1'; form.requestSubmit(); }
    });
  });

  /* auto-submitting selects */
  $$('[data-autosubmit]').forEach(sel => sel.addEventListener('change', () => { if (sel.form) sel.form.submit(); }));

  /* bulk selection */
  const bulkForm = $('#bulkForm');
  if (bulkForm) {
    const checks = $$('.row-check');
    const all = $('#checkAll');
    const bar = $('#bulkBar');
    const countEl = $('#bulkCount');
    const actionInput = $('#bulkAction');
    const sync = () => {
      const n = checks.filter(c => c.checked).length;
      countEl.textContent = n + ' selected';
      bar.classList.toggle('show', n > 0);
      if (all) { all.checked = n > 0 && n === checks.length; all.indeterminate = n > 0 && n < checks.length; }
    };
    checks.forEach(c => c.addEventListener('change', sync));
    if (all) all.addEventListener('change', () => { checks.forEach(c => { c.checked = all.checked; }); sync(); });
    const clearBtn = $('#bulkClear');
    if (clearBtn) clearBtn.addEventListener('click', () => { checks.forEach(c => { c.checked = false; }); sync(); });
    $$('[data-bulk]').forEach(btn => btn.addEventListener('click', async () => {
      const act = btn.dataset.bulk;
      if (!checks.some(c => c.checked)) return;
      if (act === 'trash' || act === 'destroy') {
        const ok = await askConfirm(btn.dataset.confirm || 'Are you sure?', btn.dataset.confirmLabel || 'Confirm');
        if (!ok) return;
      }
      actionInput.value = act;
      bulkForm.requestSubmit();
    }));
    sync();
  }

  /* markdown editors */
  function setupEditor(root) {
    const area = root.querySelector('.ed-area');
    const preview = root.querySelector('.ed-preview');
    const body = root.querySelector('.ed-body');
    if (!area || !preview || !body) return;
    const tabs = $$('.ed-tab', root);
    const wordsEl = root.querySelector('[data-words]');
    const readEl = root.querySelector('[data-read]');
    const saveNote = root.querySelector('[data-save-note]');
    const form = root.closest('form');
    const key = 'ld-draft:' + (root.dataset.key || location.pathname);
    const initial = area.value;

    function renderPreview() {
      const src = area.value;
      if (window.marked && window.DOMPurify) {
        let html = window.marked.parse(src, { gfm: true, breaks: true });
        html = window.DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
        html = html.replace(/<h1(\s|>)/g, '<h2$1').replace(/<\/h1>/g, '</h2>');
        preview.innerHTML = html || '<p class="ed-empty">Nothing to preview yet.</p>';
        $$('a', preview).forEach(a => {
          if (/^https?:/i.test(a.getAttribute('href') || '')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        });
      } else {
        preview.textContent = src;
      }
    }
    function counts() {
      const t = area.value.replace(/[#>*_~`\[\]!]/g, ' ').replace(/\s+/g, ' ').trim();
      const n = t ? t.split(' ').length : 0;
      if (wordsEl) wordsEl.textContent = n + (n === 1 ? ' word' : ' words');
      if (readEl) readEl.textContent = Math.max(1, Math.round(n / 220)) + ' min read';
    }
    let saveTimer = null;
    function autosave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try {
          localStorage.setItem(key, JSON.stringify({ v: area.value, t: Date.now() }));
          const d = new Date();
          if (saveNote) saveNote.textContent = 'Saved locally \u00b7 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        } catch (e) { /* storage unavailable */ }
      }, 700);
    }
    area.addEventListener('input', () => { renderPreview(); counts(); autosave(); });
    tabs.forEach(tab => tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      body.className = 'ed-body mode-' + tab.dataset.mode;
      if (tab.dataset.mode !== 'write') renderPreview();
    }));
    if (matchMedia('(min-width: 1100px)').matches) {
      const split = tabs.find(t => t.dataset.mode === 'split');
      if (split) { tabs.forEach(t => t.classList.toggle('active', t === split)); body.className = 'ed-body mode-split'; }
    }

    const wrapCmds = { bold: ['**', '**', 'bold text'], italic: ['*', '*', 'italic text'] };
    const lineCmds = { h2: '## ', h3: '### ', quote: '> ', ul: '- ' };
    $$('[data-cmd]', root).forEach(btn => btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      const s = area.selectionStart, e = area.selectionEnd, v = area.value;
      const sel = v.slice(s, e);
      if (wrapCmds[cmd]) {
        const [pre, post, ph] = wrapCmds[cmd];
        const inner = sel || ph;
        area.setRangeText(pre + inner + post, s, e, 'end');
        if (!sel) { area.selectionStart = s + pre.length; area.selectionEnd = s + pre.length + inner.length; }
      } else if (cmd === 'code') {
        const fence = '`'.repeat(3);
        if (sel.includes('\n')) {
          area.setRangeText('\n' + fence + '\n' + sel + '\n' + fence + '\n', s, e, 'end');
        } else {
          const inner = sel || 'code';
          area.setRangeText('`' + inner + '`', s, e, 'end');
          if (!sel) { area.selectionStart = s + 1; area.selectionEnd = s + 1 + inner.length; }
        }
      } else if (lineCmds[cmd]) {
        const prefix = lineCmds[cmd];
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        let le = v.indexOf('\n', e); if (le === -1) le = v.length;
        const lines = v.slice(ls, le).split('\n');
        const has = lines.every(l => l.startsWith(prefix));
        const out = lines.map(l => has ? l.slice(prefix.length) : prefix + l).join('\n');
        area.setRangeText(out, ls, le, 'end');
      } else if (cmd === 'ol') {
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        let le = v.indexOf('\n', e); if (le === -1) le = v.length;
        const lines = v.slice(ls, le).split('\n');
        const has = lines.every(l => /^\d+\.\s/.test(l));
        const out = lines.map((l, i) => has ? l.replace(/^\d+\.\s/, '') : (i + 1) + '. ' + l).join('\n');
        area.setRangeText(out, ls, le, 'end');
      } else if (cmd === 'link') {
        const inner = sel || 'link text';
        area.setRangeText('[' + inner + '](https://)', s, e, 'end');
      } else if (cmd === 'image') {
        const inner = sel || 'alt text';
        area.setRangeText('![' + inner + '](/covers/)', s, e, 'end');
      } else if (cmd === 'hr') {
        area.setRangeText('\n\n---\n\n', s, e, 'end');
      }
      area.focus();
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }));

    const restore = root.querySelector('[data-restore]');
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { /* ignore */ }
    if (restore && stored && stored.v && stored.v !== initial) {
      restore.hidden = false;
      restore.querySelector('[data-restore-yes]').addEventListener('click', () => {
        area.value = stored.v;
        restore.hidden = true;
        area.dispatchEvent(new Event('input', { bubbles: true }));
        toast('Local draft restored.', 'ok');
      });
      restore.querySelector('[data-restore-no]').addEventListener('click', () => {
        restore.hidden = true;
        try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
      });
    }
    if (form) form.addEventListener('submit', () => { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } });
    renderPreview();
    counts();
  }
  $$('[data-editor]').forEach(setupEditor);

  /* post form niceties */
  const postForm = $('#postForm');
  if (postForm) {
    const title = $('#f-title'), slug = $('#f-slug'), excerpt = $('#f-excerpt'), exCount = $('#excerptCount');
    let slugTouched = !!(slug && slug.value.trim());
    const slugify = s => s.toLowerCase().normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    if (title && slug) {
      title.addEventListener('input', () => { if (!slugTouched) slug.value = slugify(title.value); });
      slug.addEventListener('input', () => { slugTouched = !!slug.value.trim(); });
    }
    if (excerpt && exCount) {
      const upd = () => { exCount.textContent = excerpt.value.length + ' / 300'; };
      excerpt.addEventListener('input', upd);
      upd();
    }
    let dirty = false;
    postForm.addEventListener('input', () => { dirty = true; });
    postForm.addEventListener('submit', () => { dirty = false; });
    window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('keydown', e => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        const primary = postForm.querySelector('[data-primary-save]');
        postForm.requestSubmit(primary || undefined);
      } else if ((k === 'b' || k === 'i') && document.activeElement && document.activeElement.classList.contains('ed-area')) {
        e.preventDefault();
        const ed = document.activeElement.closest('[data-editor]');
        const btn = ed && ed.querySelector('[data-cmd="' + (k === 'b' ? 'bold' : 'italic') + '"]');
        if (btn) btn.click();
      }
    });
  }

  /* cover preview */
  const coverInput = $('#f-cover'), coverImg = $('#coverPreview');
  if (coverInput && coverImg) {
    const upd = () => {
      const v = coverInput.value.trim();
      if (v) { coverImg.src = v; coverImg.hidden = false; } else { coverImg.hidden = true; }
    };
    coverInput.addEventListener('input', upd);
    coverImg.addEventListener('error', () => { coverImg.hidden = true; });
  }

  /* books drag reorder */
  const bookList = $('#bookList'), orderForm = $('#orderForm');
  if (bookList && orderForm) {
    let dragEl = null, dropped = false;
    const rows = () => $$('.book-row', bookList);
    function syncOrder() {
      const ids = rows().map(r => r.dataset.id);
      orderForm.innerHTML = '';
      const add = (n, v) => { const i = document.createElement('input'); i.type = 'hidden'; i.name = n; i.value = v; orderForm.appendChild(i); };
      add('csrf', orderForm.dataset.csrf);
      ids.forEach(id => add('order', id));
      orderForm.requestSubmit();
    }
    rows().forEach(row => {
      const handle = row.querySelector('.drag-handle');
      if (handle) handle.addEventListener('mousedown', () => { row.draggable = true; });
      row.addEventListener('dragstart', e => {
        dragEl = row; dropped = false;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', row.dataset.id); } catch (err) { /* IE */ }
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        row.draggable = false;
        rows().forEach(r => r.classList.remove('drop-above', 'drop-below'));
        if (dropped) syncOrder();
        dragEl = null; dropped = false;
      });
      row.addEventListener('dragover', e => {
        if (!dragEl || row === dragEl) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const above = (e.clientY - rect.top) < rect.height / 2;
        row.classList.toggle('drop-above', above);
        row.classList.toggle('drop-below', !above);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
      row.addEventListener('drop', e => {
        if (!dragEl || row === dragEl) return;
        e.preventDefault();
        const above = row.classList.contains('drop-above');
        bookList.insertBefore(dragEl, above ? row : row.nextSibling);
        row.classList.remove('drop-above', 'drop-below');
        dropped = true;
      });
      document.addEventListener('mouseup', () => { row.draggable = false; });
    });
  }

  /* copy subscriber emails */
  const copyBtn = $('#copyEmails');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const emails = $$('.sub-email').map(el => el.textContent.trim()).join(', ');
    try { await navigator.clipboard.writeText(emails); toast('Emails copied to clipboard.', 'ok'); }
    catch (e) { toast('Copy failed \u2014 select and copy manually.', 'err'); }
  });
})();
