// server.js — The Long Draft (Vercel + Turso edition; same routes and data as the SQLite version)
'use strict';
const path = require('path'), fs = require('fs'), crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('\n  Missing ADMIN_PASSWORD. Start the site like this (Git Bash):\n    ADMIN_PASSWORD="choose-a-password" node server.js\n');
  if (process.env.VERCEL) throw new Error('ADMIN_PASSWORD is not set');
  process.exit(1);
}
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('the-long-draft:' + ADMIN_PASSWORD).digest('hex');
const IS_PROD = !!process.env.VERCEL || process.env.COOKIE_SECURE === '1';

const app = express();
app.locals.siteName = process.env.SITE_NAME || 'The Long Draft';
const VIEWS = path.join(__dirname, 'views');
try { fs.readdirSync(VIEWS); fs.readdirSync(path.join(VIEWS, 'partials')); } catch (e) { console.error('views folder problem:', e.message); }

/* ---------------- database: Turso on Vercel, local file at home ---------------- */
const db = createClient(process.env.TURSO_DATABASE_URL
  ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
  : { url: 'file:' + path.join(process.env.DATA_DIR || __dirname, 'site.db') });
const q = async (sql, args = []) => {
  const r = await db.execute({ sql, args });
  return r.rows.map(row => { const o = {}; r.columns.forEach((c, i) => { o[c] = row[i]; }); return o; });
};
const one = async (sql, args) => (await q(sql, args))[0] || null;
const run = async (sql, args = []) => { const r = await db.execute({ sql, args }); return { changes: r.rowsAffected, id: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid) }; };
const st = (sql, args = []) => ({ sql, args });
const batch = stmts => db.batch(stmts, 'write');
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const SETTING_DEFAULTS = (() => {
  try { return require('./seed.json').defaults; }
  catch (e) { return { author_name: 'Your Name', tagline: '', location: '', email: '', website: '', bio: '' }; }
})();

async function seed() {
  let S; try { S = require('./seed.json'); } catch (e) { return; }
  const n = async t => (await one('SELECT COUNT(*) n FROM ' + t)).n;
  const rows = (sql, list) => list.map(a => st(sql, a));
  const stmts = [];
  if (!(await n('posts'))) stmts.push(...rows('INSERT OR IGNORE INTO posts (title, slug, excerpt, body, status, created_at, updated_at, published_at) VALUES (?,?,?,?,?,?,?,?)', S.posts));
  if (!(await n('books'))) stmts.push(...rows('INSERT INTO books (title, subtitle, year, cover, buy_url, blurb, sort_order) VALUES (?,?,?,?,?,?,?)', S.books));
  if (!(await n('settings'))) stmts.push(...rows('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', S.settings));
  if (!(await n('subscribers'))) stmts.push(...rows('INSERT OR IGNORE INTO subscribers (email, created_at) VALUES (?,?)', S.subscribers));
  if (stmts.length) await batch(stmts);
}
const ready = (async () => {
  try {
    const cols = (await q('PRAGMA table_info(posts)')).map(c => c.name);
    if (cols.length && !cols.includes('status')) await db.execute('ALTER TABLE posts RENAME TO posts_old_v1');
  } catch (e) { /* fresh database */ }
  await db.batch([
    `CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      excerpt TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('published','draft','trashed')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '',
      year INTEGER, cover TEXT NOT NULL DEFAULT '', buy_url TEXT NOT NULL DEFAULT '', blurb TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS subscribers (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status)`
  ], 'write');
  await seed().catch(e => console.error('seed skipped:', e.message));
})();
ready.catch(() => {});

/* ---------------- helpers ---------------- */
const nowISO = () => new Date().toISOString();
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function parseDate(s) { const str = String(s || ''); return new Date(str.length === 10 ? str + 'T12:00:00Z' : (str || Date.now())); }
function fmtDate(s) { const d = parseDate(s); return d.getUTCDate() + ' ' + MONTHS_FULL[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
function dateParts(s) { const d = parseDate(s); return { day: String(d.getUTCDate()).padStart(2, '0'), mon: MONTHS[d.getUTCMonth()], year: String(d.getUTCFullYear()) }; }
function slugify(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80); }
async function uniqueSlug(base, excludeId) {
  const root = base || 'post'; let c = root, n = 2;
  while (await one('SELECT id FROM posts WHERE slug = ? AND id IS NOT ?', [c, excludeId == null ? -1 : Number(excludeId)])) c = root + '-' + (n++);
  return c;
}
marked.use({ gfm: true, breaks: true });
const SANITIZE_OPTS = {
  allowedTags: ['h1','h2','h3','h4','p','br','hr','blockquote','ul','ol','li','strong','em','del','code','pre','a','img','table','thead','tbody','tr','th','td'],
  allowedAttributes: { a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title', 'loading', 'decoding'] },
  allowedSchemes: ['http', 'https', 'mailto'], allowedSchemesByTag: { img: ['http', 'https'] }, allowProtocolRelative: false,
  transformTags: {
    a: (tag, attrs) => ({ tagName: 'a', attribs: Object.assign({}, attrs, /^https?:/i.test(attrs.href || '') ? { target: '_blank', rel: 'noopener noreferrer' } : { rel: 'noopener' }) }),
    img: (tag, attrs) => ({ tagName: 'img', attribs: Object.assign({}, attrs, { loading: 'lazy', decoding: 'async' }) })
  }
};
function renderMarkdown(src) {
  const raw = marked.parse(String(src || ''), { gfm: true, breaks: true, async: false });
  return sanitizeHtml(raw, SANITIZE_OPTS).replace(/<h1(\s|>)/g, '<h2$1').replace(/<\/h1>/g, '</h2>');
}
function plainText(src) {
  return String(src || '').replace(/```[\s\S]*?```/g, ' ').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`]/g, '').replace(/^\s*[-+]\s+/gm, '').replace(/\s+/g, ' ').trim();
}
function autoExcerpt(body) { const t = plainText(body); return t.length > 180 ? t.slice(0, 180).replace(/\s+\S*$/, '') + '…' : t; }
function wordCount(body) { const t = plainText(body); return t ? t.split(' ').length : 0; }
function readMin(body) { return Math.max(1, Math.round(wordCount(body) / 220)); }
function escapeXml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function wantsJson(req) { return String(req.get('accept') || '').includes('application/json'); }
function safeBack(v, fallback) { v = String(v || ''); return /^\/(?![\/\\])/.test(v) ? v : fallback; }
function flash(req, type, text, action) { req.session.flash = { type, text, action: action || null }; }
function toSettings(rows) {
  const raw = Object.assign({}, SETTING_DEFAULTS);
  for (const r of rows) raw[r.key] = r.value;
  return { authorName: raw.author_name, tagline: raw.tagline, location: raw.location, email: raw.email, website: raw.website, bio: raw.bio };
}
const likeBang = s => '%' + s.replace(/[!%_]/g, ch => '!' + ch) + '%';

/* ---------------- middleware ---------------- */
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', VIEWS);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0 }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use((req, res, next) => { req.body = req.body || {}; next(); });
app.use(cookieSession({ name: 'ld.sid', keys: [SESSION_SECRET], maxAge: 7 * 864e5, httpOnly: true, sameSite: 'lax', secure: IS_PROD, path: '/' }));
app.use(h(async (req, res, next) => {
  await ready;
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  const [s, l] = await db.batch([
    st('SELECT key, value FROM settings'),
    st("SELECT slug FROM posts WHERE status='published' ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT 1")
  ], 'read');
  Object.assign(res.locals, {
    siteName: app.locals.siteName, settings: toSettings(s.rows), currentPath: req.path, currentUrl: req.originalUrl,
    isAdmin: !!req.session.isAdmin, csrf: req.session.csrf, flash: req.session.flash || null,
    pageTitle: '', bodyClass: '', pageDesc: '', useEditor: false, statusCode: 404, message: '',
    latestSlug: l.rows[0] ? l.rows[0].slug : null, fmtDate, dateParts, readMin, wordCount, renderMd: renderMarkdown, year: new Date().getUTCFullYear()
  });
  if (req.session.flash) delete req.session.flash;
  next();
}));
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const a = String(req.body.csrf || ''), b = String(req.session.csrf || '');
  const ok = a.length > 0 && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (ok) return next();
  if (wantsJson(req)) return res.status(403).json({ ok: false, message: 'Your session expired — reload the page and try again.' });
  return res.status(403).render('404', { statusCode: 403, message: 'Your session expired. Go back, reload the page, and try again.' });
});

const loginHits = new Map();
function loginLock(ip) { const r = loginHits.get(ip); return r && r.until > Date.now() ? Math.ceil((r.until - Date.now()) / 60000) : 0; }
const subHits = new Map();
function subBlocked(ip) { const now = Date.now(); const arr = (subHits.get(ip) || []).filter(t => now - t < 60000); arr.push(now); subHits.set(ip, arr); return arr.length > 8; }
function requireAdmin(req, res, next) { if (req.session.isAdmin) return next(); res.redirect('/admin/login'); }

/* ---------------- public routes ---------------- */
app.get('/', h(async (req, res) => {
  const qs = String(req.query.q || '').trim().slice(0, 80), per = 6;
  let where = "status='published'"; const params = [];
  if (qs) { where += " AND (title LIKE ? ESCAPE '!' OR body LIKE ? ESCAPE '!')"; const like = likeBang(qs); params.push(like, like); }
  const total = (await one('SELECT COUNT(*) n FROM posts WHERE ' + where, params)).n;
  const pages = Math.max(1, Math.ceil(total / per));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const [posts, tp, bc] = await Promise.all([
    q('SELECT * FROM posts WHERE ' + where + ' ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT ? OFFSET ?', [...params, per, (page - 1) * per]),
    one("SELECT COUNT(*) n FROM posts WHERE status='published'"), one('SELECT COUNT(*) n FROM books')
  ]);
  const u = new URLSearchParams(); if (qs) u.set('q', qs); const s = u.toString();
  res.render('index', { posts, q: qs, total, page, pages, pageBase: '/?' + (s ? s + '&' : ''), totalPublished: tp.n, bookCount: bc.n });
}));
app.get('/about', h(async (req, res) => res.render('about', { books: await q('SELECT * FROM books ORDER BY sort_order ASC, id ASC') })));
app.get('/posts/:slug', h(async (req, res, next) => {
  const post = await one('SELECT * FROM posts WHERE slug = ?', [req.params.slug]);
  if (!post || (post.status !== 'published' && !req.session.isAdmin)) return next();
  const key = post.published_at || post.created_at;
  const [newer, older] = await Promise.all([
    one("SELECT slug, title FROM posts WHERE status='published' AND COALESCE(published_at, created_at) > ? AND id != ? ORDER BY COALESCE(published_at, created_at) ASC, id ASC LIMIT 1", [key, post.id]),
    one("SELECT slug, title FROM posts WHERE status='published' AND COALESCE(published_at, created_at) < ? AND id != ? ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT 1", [key, post.id])
  ]);
  res.render('post', { post, html: renderMarkdown(post.body), newer, older });
}));
app.get('/feed.xml', h(async (req, res) => {
  const base = req.protocol + '://' + req.get('host');
  const posts = await q("SELECT * FROM posts WHERE status='published' ORDER BY COALESCE(published_at, created_at) DESC LIMIT 20");
  const items = posts.map(p => `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${base}/posts/${p.slug}</link>
      <guid isPermaLink="true">${base}/posts/${p.slug}</guid>
      <pubDate>${parseDate(p.published_at || p.created_at).toUTCString()}</pubDate>
      <description>${escapeXml(p.excerpt || autoExcerpt(p.body))}</description>
    </item>`).join('\n');
  res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(app.locals.siteName)}</title>
    <link>${base}</link>
    <description>${escapeXml(res.locals.settings.tagline)}</description>
    <language>en</language>
${items}
  </channel>
</rss>`);
}));
app.post('/subscribe', h(async (req, res) => {
  const back = safeBack(req.body.back, '/');
  const respond = (ok, message, code) => {
    if (wantsJson(req)) return res.status(code || (ok ? 200 : 422)).json({ ok, message });
    flash(req, ok ? 'ok' : 'err', message);
    return res.redirect(back);
  };
  if (String(req.body.company || '').trim()) return respond(true, "You're on the list. The next Margin will find you.");
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return respond(false, 'That email address doesn\u2019t look right — mind checking it?');
  if (subBlocked(req.ip)) return respond(false, 'Too many signups from this connection — try again in a minute.', 429);
  const info = await run('INSERT INTO subscribers (email, created_at) VALUES (?,?) ON CONFLICT(email) DO NOTHING', [email, nowISO()]);
  return respond(true, info.changes ? "You're on the list. The next Margin will find you." : "You're already on the list — thank you for staying.");
}));

/* ---------------- admin auth ---------------- */
app.get('/admin/login', (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin');
  res.render('login', { error: null, loggedOut: req.query.bye === '1' });
});
app.post('/admin/login', (req, res) => {
  const locked = loginLock(req.ip);
  if (locked) return res.status(429).render('login', { error: 'Too many attempts. Try again in ' + locked + ' minute' + (locked === 1 ? '' : 's') + '.', loggedOut: false });
  if (!bcrypt.compareSync(String(req.body.password || ''), ADMIN_HASH)) {
    const r = loginHits.get(req.ip) || { count: 0, until: 0 };
    r.count++;
    if (r.count >= 6) { r.until = Date.now() + 10 * 60000; r.count = 0; }
    loginHits.set(req.ip, r);
    return res.status(401).render('login', { error: 'That password didn\u2019t match.', loggedOut: false });
  }
  loginHits.delete(req.ip);
  req.session = { isAdmin: true, csrf: crypto.randomBytes(24).toString('hex') };
  res.redirect('/admin');
});
app.use('/admin', requireAdmin);
app.post('/admin/logout', (req, res) => { req.session = null; res.redirect('/admin/login?bye=1'); });

/* ---------------- admin: posts ---------------- */
app.get('/admin', h(async (req, res) => {
  const statusFilter = ['published', 'draft', 'trashed'].includes(req.query.status) ? req.query.status : 'all';
  const qs = String(req.query.q || '').trim().slice(0, 80);
  const sortMap = { updated_desc: 'updated_at DESC, id DESC', created_desc: 'created_at DESC, id DESC', oldest: 'COALESCE(published_at, created_at) ASC, id ASC', title: 'title COLLATE NOCASE ASC' };
  const sort = sortMap[req.query.sort] ? req.query.sort : 'updated_desc';
  const where = [], params = [];
  if (statusFilter === 'all') where.push("status != 'trashed'"); else { where.push('status = ?'); params.push(statusFilter); }
  if (qs) { where.push("(title LIKE ? ESCAPE '!' OR body LIKE ? ESCAPE '!')"); const like = likeBang(qs); params.push(like, like); }
  const w = where.join(' AND '), per = 12;
  const total = (await one('SELECT COUNT(*) n FROM posts WHERE ' + w, params)).n;
  const pages = Math.max(1, Math.ceil(total / per));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const [posts, cr, sc, bc] = await Promise.all([
    q('SELECT * FROM posts WHERE ' + w + ' ORDER BY ' + sortMap[sort] + ' LIMIT ? OFFSET ?', [...params, per, (page - 1) * per]),
    q('SELECT status, COUNT(*) n FROM posts GROUP BY status'), one('SELECT COUNT(*) n FROM subscribers'), one('SELECT COUNT(*) n FROM books')
  ]);
  const counts = { published: 0, draft: 0, trashed: 0 };
  for (const r of cr) counts[r.status] = r.n;
  const u = new URLSearchParams();
  if (qs) u.set('q', qs); if (statusFilter !== 'all') u.set('status', statusFilter); if (sort !== 'updated_desc') u.set('sort', sort);
  const s = u.toString();
  res.render('dashboard', { posts, statusFilter, q: qs, sort, page, pages, total, pageBase: '/admin?' + (s ? s + '&' : ''), counts, subscriberCount: sc.n, bookCount: bc.n });
}));
app.get('/admin/posts/new', (req, res) => res.render('edit', { post: null, formError: null }));
function readPostForm(req) {
  const title = String(req.body.title || '').trim().slice(0, 200), body = String(req.body.body || '');
  const excerpt = String(req.body.excerpt || '').trim().slice(0, 300);
  const status = req.body.status === 'published' ? 'published' : 'draft';
  if (!title || !body.trim()) return null;
  return { title, body, excerpt: excerpt || autoExcerpt(body), status, slugBase: slugify(String(req.body.slug || '') || title) };
}
const getPost = id => one('SELECT * FROM posts WHERE id = ?', [id]);
app.post('/admin/posts', h(async (req, res) => {
  const data = readPostForm(req);
  if (!data) return res.status(422).render('edit', { post: { id: null, title: req.body.title || '', slug: req.body.slug || '', excerpt: req.body.excerpt || '', body: req.body.body || '', status: 'draft', created_at: null, updated_at: null, published_at: null }, formError: 'A title and some text are required.' });
  const slug = await uniqueSlug(data.slugBase), now = nowISO();
  const info = await run('INSERT INTO posts (title, slug, excerpt, body, status, created_at, updated_at, published_at) VALUES (?,?,?,?,?,?,?,?)',
    [data.title, slug, data.excerpt, data.body, data.status, now, now, data.status === 'published' ? now : null]);
  flash(req, 'ok', data.status === 'published' ? 'Published.' : 'Draft saved.', data.status === 'published' ? { label: 'View', url: '/posts/' + slug, method: 'get' } : null);
  res.redirect('/admin/posts/' + info.id + '/edit');
}));
app.post('/admin/posts/empty-trash', h(async (req, res) => {
  const info = await run("DELETE FROM posts WHERE status='trashed'");
  flash(req, 'ok', info.changes + ' post' + (info.changes === 1 ? '' : 's') + ' deleted for good.');
  res.redirect('/admin?status=trashed');
}));
app.post('/admin/posts/bulk', h(async (req, res) => {
  let ids = req.body.ids || []; if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(n => parseInt(n, 10)).filter(Number.isInteger);
  const action = String(req.body.action || ''), now = nowISO();
  const ops = {
    publish: id => st("UPDATE posts SET status='published', published_at=COALESCE(published_at, ?), updated_at=? WHERE id=? AND status!='trashed'", [now, now, id]),
    draft: id => st("UPDATE posts SET status='draft', updated_at=? WHERE id=? AND status!='trashed'", [now, id]),
    trash: id => st("UPDATE posts SET status='trashed', updated_at=? WHERE id=? AND status!='trashed'", [now, id]),
    restore: id => st("UPDATE posts SET status='draft', updated_at=? WHERE id=? AND status='trashed'", [now, id]),
    destroy: id => st("DELETE FROM posts WHERE id=? AND status='trashed'", [id])
  };
  let n = 0;
  if (ops[action] && ids.length) n = (await batch(ids.map(ops[action]))).reduce((a, r) => a + r.rowsAffected, 0);
  const verbs = { publish: 'published', draft: 'moved to drafts', trash: 'moved to trash', restore: 'restored as drafts', destroy: 'deleted for good' };
  flash(req, 'ok', n + ' post' + (n === 1 ? '' : 's') + ' ' + (verbs[action] || 'updated') + '.');
  res.redirect(safeBack(req.body.back, '/admin'));
}));
app.get('/admin/posts/:id/edit', h(async (req, res, next) => {
  const post = await getPost(req.params.id);
  if (!post) return next();
  if (post.status === 'trashed') { flash(req, 'info', 'Restore this post from the trash before editing it.'); return res.redirect('/admin?status=trashed'); }
  res.render('edit', { post, formError: null });
}));
app.post('/admin/posts/:id', h(async (req, res, next) => {
  const post = await getPost(req.params.id);
  if (!post) return next();
  if (post.status === 'trashed') { flash(req, 'err', 'Restore this post before editing.'); return res.redirect('/admin?status=trashed'); }
  const data = readPostForm(req);
  if (!data) return res.status(422).render('edit', { post: Object.assign({}, post, { title: req.body.title || '', slug: req.body.slug || '', excerpt: req.body.excerpt || '', body: req.body.body || '' }), formError: 'A title and some text are required.' });
  const slug = await uniqueSlug(data.slugBase, post.id), now = nowISO();
  const publishedAt = data.status === 'published' ? (post.published_at || now) : post.published_at;
  await run('UPDATE posts SET title=?, slug=?, excerpt=?, body=?, status=?, updated_at=?, published_at=? WHERE id=?', [data.title, slug, data.excerpt, data.body, data.status, now, publishedAt, post.id]);
  flash(req, 'ok', data.status === 'published' ? 'Saved and live.' : 'Saved as a draft.', data.status === 'published' ? { label: 'View', url: '/posts/' + slug, method: 'get' } : null);
  res.redirect('/admin/posts/' + post.id + '/edit');
}));
app.post('/admin/posts/:id/trash', h(async (req, res, next) => {
  const post = await getPost(req.params.id); if (!post) return next();
  await run("UPDATE posts SET status='trashed', updated_at=? WHERE id=?", [nowISO(), post.id]);
  flash(req, 'info', '\u201C' + post.title + '\u201D moved to trash.', { label: 'Undo', url: '/admin/posts/' + post.id + '/restore', method: 'post' });
  res.redirect(safeBack(req.body.back, '/admin'));
}));
app.post('/admin/posts/:id/restore', h(async (req, res, next) => {
  const post = await getPost(req.params.id); if (!post) return next();
  await run("UPDATE posts SET status='draft', updated_at=? WHERE id=?", [nowISO(), post.id]);
  flash(req, 'ok', '\u201C' + post.title + '\u201D restored as a draft.');
  res.redirect(safeBack(req.body.back, '/admin'));
}));
app.post('/admin/posts/:id/destroy', h(async (req, res, next) => {
  const post = await getPost(req.params.id); if (!post) return next();
  await run("DELETE FROM posts WHERE id=? AND status='trashed'", [post.id]);
  flash(req, 'ok', 'Deleted for good.');
  res.redirect('/admin?status=trashed');
}));

/* ---------------- admin: books ---------------- */
async function normalizeBookOrder() {
  const rows = await q('SELECT id, sort_order FROM books ORDER BY sort_order ASC, id ASC');
  const upd = rows.map((r, i) => r.sort_order !== i ? st('UPDATE books SET sort_order=? WHERE id=?', [i, r.id]) : null).filter(Boolean);
  if (upd.length) await batch(upd);
}
function readBookForm(req) {
  const title = String(req.body.title || '').trim().slice(0, 160), subtitle = String(req.body.subtitle || '').trim().slice(0, 120);
  let year = parseInt(req.body.year, 10); year = Number.isInteger(year) && year >= 1400 && year <= 2100 ? year : null;
  const cover = String(req.body.cover || '').trim().slice(0, 300), buyUrl = String(req.body.buy_url || '').trim().slice(0, 300), blurb = String(req.body.blurb || '').trim().slice(0, 600);
  if (!title) return { error: 'A title is required.' };
  if (buyUrl && !/^https?:\/\/.+/i.test(buyUrl)) return { error: 'The buy link must start with http:// or https://.' };
  if (cover && !/^(\/|https?:\/\/)/i.test(cover)) return { error: 'The cover must be a path like /covers/my-book.svg or a full image URL.' };
  return { title, subtitle, year, cover, buyUrl, blurb };
}
const getBook = id => one('SELECT * FROM books WHERE id = ?', [id]);
app.get('/admin/books', h(async (req, res) => res.render('books', { books: await q('SELECT * FROM books ORDER BY sort_order ASC, id ASC') })));
app.get('/admin/books/new', (req, res) => res.render('book-edit', { book: null, formError: null }));
app.post('/admin/books', h(async (req, res) => {
  const data = readBookForm(req);
  if (data.error) return res.status(422).render('book-edit', { book: Object.assign({ id: null }, req.body), formError: data.error });
  const max = (await one('SELECT COALESCE(MAX(sort_order), -1) m FROM books')).m;
  await run('INSERT INTO books (title, subtitle, year, cover, buy_url, blurb, sort_order) VALUES (?,?,?,?,?,?,?)', [data.title, data.subtitle, data.year, data.cover, data.buyUrl, data.blurb, max + 1]);
  flash(req, 'ok', '\u201C' + data.title + '\u201D added to the shelf.', { label: 'View', url: '/about#books', method: 'get' });
  res.redirect('/admin/books');
}));
app.post('/admin/books/reorder', h(async (req, res) => {
  let order = req.body.order || []; if (!Array.isArray(order)) order = [order];
  const upd = order.map((id, i) => [i, parseInt(id, 10)]).filter(a => Number.isInteger(a[1])).map(a => st('UPDATE books SET sort_order=? WHERE id=?', a));
  if (upd.length) await batch(upd);
  await normalizeBookOrder();
  flash(req, 'ok', 'Shelf order saved.');
  res.redirect('/admin/books');
}));
app.get('/admin/books/:id/edit', h(async (req, res, next) => {
  const book = await getBook(req.params.id); if (!book) return next();
  res.render('book-edit', { book, formError: null });
}));
app.post('/admin/books/:id/delete', h(async (req, res, next) => {
  const book = await getBook(req.params.id); if (!book) return next();
  await run('DELETE FROM books WHERE id=?', [book.id]);
  await normalizeBookOrder();
  flash(req, 'ok', '\u201C' + book.title + '\u201D removed from the shelf.');
  res.redirect('/admin/books');
}));
app.post('/admin/books/:id/move', h(async (req, res, next) => {
  const rows = await q('SELECT id FROM books ORDER BY sort_order ASC, id ASC');
  const idx = rows.findIndex(r => String(r.id) === String(req.params.id));
  if (idx === -1) return next();
  const swap = req.body.dir === 'up' ? idx - 1 : idx + 1;
  if (swap >= 0 && swap < rows.length) [rows[idx], rows[swap]] = [rows[swap], rows[idx]];
  await batch(rows.map((r, i) => st('UPDATE books SET sort_order=? WHERE id=?', [i, r.id])));
  res.redirect('/admin/books');
}));
app.post('/admin/books/:id', h(async (req, res, next) => {
  const book = await getBook(req.params.id); if (!book) return next();
  const data = readBookForm(req);
  if (data.error) return res.status(422).render('book-edit', { book: Object.assign({}, book, req.body), formError: data.error });
  await run('UPDATE books SET title=?, subtitle=?, year=?, cover=?, buy_url=?, blurb=? WHERE id=?', [data.title, data.subtitle, data.year, data.cover, data.buyUrl, data.blurb, book.id]);
  flash(req, 'ok', 'Book saved.', { label: 'View', url: '/about#books', method: 'get' });
  res.redirect('/admin/books');
}));

/* ---------------- admin: settings & subscribers ---------------- */
app.get('/admin/settings', (req, res) => res.render('settings', { formError: null }));
app.post('/admin/settings', h(async (req, res) => {
  const t = (k, n) => String(req.body[k] || '').trim().slice(0, n);
  const authorName = t('authorName', 120), tagline = t('tagline', 200), location = t('location', 120), email = t('email', 254), website = t('website', 300);
  const bio = String(req.body.bio || '').slice(0, 20000);
  if (!authorName) return res.status(422).render('settings', { formError: 'The author name is required.' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(422).render('settings', { formError: 'That contact email doesn\u2019t look right.' });
  if (website && !/^https?:\/\/.+/i.test(website)) return res.status(422).render('settings', { formError: 'The website must start with http:// or https://.' });
  const pairs = { author_name: authorName, tagline, location, email, website, bio };
  await batch(Object.entries(pairs).map(([k, v]) => st('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, v])));
  flash(req, 'ok', 'Settings saved.', { label: 'View author page', url: '/about', method: 'get' });
  res.redirect('/admin/settings');
}));
app.get('/admin/subscribers', h(async (req, res) => res.render('subscribers', { subscribers: await q('SELECT * FROM subscribers ORDER BY created_at DESC, id DESC') })));
app.get('/admin/subscribers.csv', h(async (req, res) => {
  const rows = await q('SELECT email, created_at FROM subscribers ORDER BY created_at ASC');
  const csv = 'email,subscribed_at\n' + rows.map(r => '"' + r.email.replace(/"/g, '""') + '","' + r.created_at + '"').join('\n');
  res.setHeader('Content-Disposition', 'attachment; filename="subscribers.csv"');
  res.type('text/csv').send(csv);
}));
app.post('/admin/subscribers/:id/delete', h(async (req, res, next) => {
  const row = await one('SELECT * FROM subscribers WHERE id = ?', [req.params.id]); if (!row) return next();
  await run('DELETE FROM subscribers WHERE id=?', [row.id]);
  flash(req, 'ok', row.email + ' removed from the list.');
  res.redirect('/admin/subscribers');
}));

/* ---------------- errors & boot ---------------- */
app.use((req, res) => res.status(404).render('404', { statusCode: 404, message: '' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).render('404', { statusCode: 500, message: 'The error has been logged. Try again in a moment.' });
});
module.exports = app;
const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => console.log(app.locals.siteName + ' \u2192 http://localhost:' + PORT + '  (desk: /admin)'));
