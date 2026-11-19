// server.js — The Long Draft
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('\n  Missing ADMIN_PASSWORD. Start the site like this (Git Bash):\n');
  console.error('    ADMIN_PASSWORD="choose-a-password" node server.js\n');
  process.exit(1);
}
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);
const SESSION_SECRET = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('the-long-draft:' + ADMIN_PASSWORD).digest('hex');

const app = express();
app.locals.siteName = 'The Long Draft';

/* ---------------- database ---------------- */
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'site.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  excerpt TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('published','draft','trashed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  year INTEGER,
  cover TEXT NOT NULL DEFAULT '',
  buy_url TEXT NOT NULL DEFAULT '',
  blurb TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
`);

/* SQLite-backed session store (survives restarts, no extra dependency) */
class SqliteStore extends session.Store {
  constructor(database) {
    super();
    this._get = database.prepare('SELECT data, expires FROM sessions WHERE sid = ?');
    this._set = database.prepare('INSERT INTO sessions (sid, expires, data) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET expires=excluded.expires, data=excluded.data');
    this._del = database.prepare('DELETE FROM sessions WHERE sid = ?');
    this._touch = database.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    const timer = setInterval(() => database.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600e3);
    if (timer.unref) timer.unref();
  }
  _expiry(sess) {
    try { return sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 864e5; }
    catch (e) { return Date.now() + 7 * 864e5; }
  }
  get(sid, cb) {
    try {
      const row = this._get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) { this._del.run(sid); return cb(null, null); }
      return cb(null, JSON.parse(row.data));
    } catch (e) { return cb(null, null); }
  }
  set(sid, sess, cb) { try { this._set.run(sid, this._expiry(sess), JSON.stringify(sess)); if (cb) cb(null); } catch (e) { if (cb) cb(e); } }
  destroy(sid, cb) { try { this._del.run(sid); if (cb) cb(null); } catch (e) { if (cb) cb(e); } }
  touch(sid, sess, cb) { try { this._touch.run(this._expiry(sess), sid); if (cb) cb(null); } catch (e) { if (cb) cb(e); } }
}

/* ---------------- helpers ---------------- */
const nowISO = () => new Date().toISOString();
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function parseDate(s) { const str = String(s || ''); return new Date(str.length === 10 ? str + 'T12:00:00Z' : (str || Date.now())); }
function fmtDate(s) { const d = parseDate(s); return d.getUTCDate() + ' ' + MONTHS_FULL[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
function dateParts(s) { const d = parseDate(s); return { day: String(d.getUTCDate()).padStart(2, '0'), mon: MONTHS[d.getUTCMonth()], year: String(d.getUTCFullYear()) }; }
function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
function uniqueSlug(base, excludeId) {
  const root = base || 'post'; let candidate = root; let n = 2;
  while (db.prepare('SELECT id FROM posts WHERE slug = ? AND id IS NOT ?').get(candidate, excludeId == null ? -1 : excludeId)) candidate = root + '-' + (n++);
  return candidate;
}
marked.use({ gfm: true, breaks: true });
const SANITIZE_OPTS = {
  allowedTags: ['h1','h2','h3','h4','p','br','hr','blockquote','ul','ol','li','strong','em','del','code','pre','a','img','table','thead','tbody','tr','th','td'],
  allowedAttributes: { a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title', 'loading', 'decoding'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  transformTags: {
    a: (tag, attrs) => ({ tagName: 'a', attribs: Object.assign({}, attrs, /^https?:/i.test(attrs.href || '') ? { target: '_blank', rel: 'noopener noreferrer' } : { rel: 'noopener' }) }),
    img: (tag, attrs) => ({ tagName: 'img', attribs: Object.assign({}, attrs, { loading: 'lazy', decoding: 'async' }) })
  }
};
function renderMarkdown(src) {
  const raw = marked.parse(String(src || ''), { gfm: true, breaks: true, async: false });
  const clean = sanitizeHtml(raw, SANITIZE_OPTS);
  return clean.replace(/<h1(\s|>)/g, '<h2$1').replace(/<\/h1>/g, '</h2>');
}
function plainText(src) {
  return String(src || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ').trim();
}
function autoExcerpt(body) { const t = plainText(body); return t.length > 180 ? t.slice(0, 180).replace(/\s+\S*$/, '') + '…' : t; }
function wordCount(body) { const t = plainText(body); return t ? t.split(' ').length : 0; }
function readMin(body) { return Math.max(1, Math.round(wordCount(body) / 220)); }
function escapeXml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function wantsJson(req) { return String(req.get('accept') || '').includes('application/json'); }
function safeBack(v, fallback) { v = String(v || ''); return /^\/(?![\/\\])/.test(v) ? v : fallback; }
function flash(req, type, text, action) { req.session.flash = { type, text, action: action || null }; }

const SETTING_DEFAULTS = {
  author_name: 'Mara Voss',
  tagline: 'Novelist & essayist. Maps, memory, and the sea.',
  location: 'Portsmouth, England',
  email: 'hello@thelongdraft.example',
  website: 'https://thelongdraft.example',
  bio: `Mara Voss writes novels about coastlines, inheritance, and the instruments people build to measure what they are afraid of losing. She is the author of **The Cartographer's Daughter** (2019), **Salt & Signal** (2022), and **Winterlight** (2025).

Before writing fiction she spent nine years as a hydrographic surveyor, charting the Solent and the approaches to Portsmouth — work that taught her that every map is an argument about what matters. She still keeps a working chart table, and most of her novels begin as a mistake on one.

She lives in Portsmouth, England, within earshot of the foghorn. This journal is where she thinks out loud between books: notes on craft, research trips, rereading, and the occasional confession about notebooks. Once a month she sends [The Margin](/#letter), a short letter about what she is writing and reading.

*For readings, rights, and blurb requests: [hello@thelongdraft.example](mailto:hello@thelongdraft.example).*`
};
function getSettings() {
  const raw = Object.assign({}, SETTING_DEFAULTS);
  for (const row of db.prepare('SELECT key, value FROM settings').all()) raw[row.key] = row.value;
  return { authorName: raw.author_name, tagline: raw.tagline, location: raw.location, email: raw.email, website: raw.website, bio: raw.bio };
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value == null ? '' : value));
}

/* ---------------- first-run seed ---------------- */
(function seed() {
  if (db.prepare('SELECT COUNT(*) n FROM posts').get().n === 0) {
    const ins = db.prepare('INSERT INTO posts (title, slug, excerpt, body, status, created_at, updated_at, published_at) VALUES (?,?,?,?,?,?,?,?)');
    const add = (title, date, excerpt, body, status) => {
      const created = date + 'T09:00:00.000Z';
      ins.run(title, uniqueSlug(slugify(title)), excerpt, body, status || 'published', created, created, status === 'draft' ? null : date);
    };
    add('The notebook is a liar', '2026-11-02', 'Every notebook promises order. Mine deliver an honest record of panic — and that, it turns out, is the useful part.', `Every notebook I buy arrives with a promise printed into its first page: *index, page numbers, archive-quality paper*. Order, it whispers. You will be a person with a system.

Three weeks later mine contain a shopping list, four bars of a song I can't place, the sentence "the harbour smells of cold pennies", and a phone number with no name. The notebook is a liar. But it is an honest liar, and I have stopped asking it to be anything else.

## The clean page problem

The danger of a beautiful notebook is that it makes you want to deserve it. You draft a sentence, decide it isn't good enough for the paper, and write nothing. The cheap spiral pad has no such aura. The cheap spiral pad is where my novels actually live.

> A notebook is not a filing cabinet. It is a net. Most of what swims past is not for keeping — but you cannot know which part matters until later.

What a notebook is genuinely for, in my experience:

- catching the sentence before it evaporates
- recording what a place *felt* like, not what it looked like
- keeping a private log of panic, which rereading later turns into a map of the book

The index pages stay empty. The archive-quality paper holds a drawing of a crab. Somewhere in the middle, three pages of nonsense quietly become chapter nine. I no longer apologise to the notebook.`);
    add('Writing the sea without getting wet', '2026-10-14', 'You can write the sea from a desk. You cannot write it from memory alone — memory edits out the boredom.', `You can write the sea from a desk. You cannot write it from memory alone — memory edits out the boredom, and the sea is mostly boredom with occasional terror, which is exactly the rhythm a reader needs to feel.

So before *Salt & Signal* I spent a year doing the unglamorous kind of research: tide tables, pilot books, the RNLI's [incident statistics](https://rnli.org/), and long conversations with people who work where the land gives up.

## What the water teaches

A lifeboat volunteer told me something I have used in every book since:

> "People think the dangerous days are the storm days. The dangerous days are the flat calm ones, when everybody relaxes."

That is also a description of the middle of a novel. The storm chapters write themselves; it is the flat calm of chapter fourteen that drowns people.

The other thing research gives you is permission. I could not invent a fog signal's character — three seconds on, ten seconds off, a voice like a door in a cellar — but once I had stood in it, I was allowed to exaggerate. Facts first; then you have earned your weather.

I still get letters from readers who assume I grew up on a lighthouse rock. I grew up forty miles inland. The sea I write is built from documents and visits, the way a chart is built from soundings: thousands of small measurements, and a confident line drawn between them.`);
    add('A plain-text decade', '2026-09-21', 'Ten years ago I lost a novel to a proprietary file format. Everything I write now begins life as plain text.', `Ten years ago I lost a novel to a proprietary file format. The program updated, the file corrupted, and six months of work became eleven megabytes of confident garbage. Since then everything I write begins life as plain text.

No app subscriptions. No sync conflicts. No company deciding my manuscript is a legacy format. Just files, named like a person who has learned something: \`winterlight-draft-07.txt\`.

## The whole system

My morning routine fits in a code block, which is the point:

\`\`\`
06:40  make tea, do not check anything
06:50  open yesterday's file, read last 300 words
07:00  write 500 words, no editing, no research
08:00  stop mid-sentence (Hemingway's trick, it works)
\`\`\`

Essays like this one get [Markdown](https://daringfireball.net/projects/markdown/) for structure — headings, links, the occasional list — because Markdown is plain text wearing a tidy shirt. It will open in anything, forever.

The rules, after a decade:

1. One file per piece, numbered versions, nothing clever
2. Back up to two places, one of them physical
3. The tool you can leave is the tool you should choose

Word processors are lovely hosts. I just prefer to own the house.`);
    add('On rereading', '2026-08-30', 'First readings are tourism. Rereading is living somewhere. A defence of the kitchen shelf of books I have read four times.', `There is a shelf in my kitchen of books I have read at least four times. Visitors apologise to it, as if the unread pile were the respectable one. I have stopped defending the shelf, but here is the defence anyway: first readings are tourism. Rereading is living somewhere.

The first time through a novel you are pulled by plot — you *need to know*. Every later reading is freed from that hunger, and you finally see the joinery: how the weather in chapter two is load-bearing, how a throwaway line on page forty is the whole book in disguise.

> You do not reread a book to find out what happens. You reread it to find out how it knew.

When I am stuck, I do not read something new. I retype a page of a book I love — slowly, by hand, like copying a master's drawing. Somewhere around the third sentence the rhythm gets into my wrists, and I can feel the decisions the writer made, including the ones they declined to make.

Then I delete the copied page, because it is not mine, and write my own bad sentences until one of them is less bad. The shelf has never once failed me. The unread pile, meanwhile, grows like a hedge. Both things are fine.`);
    add("The cartographer's mistake", '2026-07-12', 'The first novel began with a mistake on a chart: eleven metres of water where the harbour master knew there were three.', `The first novel began with a mistake on a chart. I was still surveying then, and a colleague had corrected a sounding in the wrong column — eleven metres of water where the harbour master knew there were three. For a week, on paper, the harbour had a hole in it.

I kept thinking about that hole. A room made of clerical error, down there in the cold, officially real. What would you keep in a place that exists only because someone was tired on a Tuesday?

## The book that came out of it

*The Cartographer's Daughter* is not about surveying, exactly. It is about a woman who inherits her father's atlas and finds coastlines in it that have never existed — and letters, folded into the bindings, that he never sent. Every map is an argument about what matters. Every atlas of imaginary places is an argument with yourself.

People ask which parts are autobiographical. The honest answer: the smell of the chart room, the sound of a pencil on Mylar, the specific tiredness of a Tuesday. The rest is the hole in the harbour, furnished.

I left surveying the year the book sold. My colleague — the one with the wrong column — came to the launch and had me sign a copy of the corrected chart, which hangs in my study now.

Eleven metres, it says, where there are three. He has written underneath: *you're welcome*.`);
    add('Beginnings are decisions', '2026-06-05', 'Beginnings are not inspiration. They are the first and largest of the ten thousand decisions a novel is made of.', `Beginnings are not inspiration. Beginnings are decisions — the first and largest of the ten thousand decisions a novel is made of. You are choosing a door, and every later room depends on which one you walked through.

For *Winterlight* I tried four openings before the true one:

1. **The weather report.** A page of beautiful cold. Nobody in it. Beautiful, empty, dead.
2. **The funeral.** Starting with grief is starting with the ending of something; the reader inherits a debt they never agreed to.
3. **The arrival.** A woman, a taxi, a key that doesn't fit. Close — but the taxi was doing the work a person should do.
4. **The inventory.** She opens her mother's house and starts listing what is in it, and the list begins to lie. That was the door.

Notice what the good one decides: point of view, tense of heart, the book's central distrust of surfaces. Four sentences in and the reader has signed a contract, even if they can't read it yet.

So when a beginning refuses to come, I no longer wait for the music. I list the doors. I make myself write two paragraphs through each one, badly, and see which room I want to furnish.

The music, when it arrives, is usually just the sound of a decision settling.`);
    add('Notes toward a fourth book', '2026-11-10', '', `Working title candidates: *The Thaw*, *Other People's Winters*, *A House Full of Cold*. None right yet.

- Translator returns to a town where the sun sets for the season — keep
- The estate inventory that lies — this was Winterlight's engine; the new book needs its own
- What if the letters are addressed to the house, not the people in it?
- Research: ice cores, probate law, the psychology of inherited objects
- Ask the archive at Portsmouth about winter shipping ledgers, 1911–1930

Rule for this one: no maps. (Last rule lasted two chapters.)`, 'draft');
  }
  if (db.prepare('SELECT COUNT(*) n FROM books').get().n === 0) {
    const ins = db.prepare('INSERT INTO books (title, subtitle, year, cover, buy_url, blurb, sort_order) VALUES (?,?,?,?,?,?,?)');
    ins.run("The Cartographer's Daughter", 'A novel', 2019, '/covers/cartographers-daughter.svg', 'https://bookshop.org/',
      "A mapmaker's daughter inherits an atlas of coastlines that never existed — and the letters her father never sent. A novel about the places we invent to survive the ones we lose.", 0);
    ins.run('Salt & Signal', 'A novel · Meridian Prize, 2023', 2022, '/covers/salt-and-signal.svg', 'https://uk.bookshop.org/',
      'Two keepers on a decommissioned lighthouse rock begin receiving transmissions in a dead language. As the sea rises, the messages grow personal. "A ghost story with a barometer in its chest."', 1);
    ins.run('Winterlight', 'A novel', 2025, '/covers/winterlight.svg', 'https://www.hive.co.uk/',
      "In a town where the sun sets for the season, a translator returns to settle her mother's estate and finds the house full of other people's winters. A novel of inheritance, translation, and thaw.", 2);
  }
  if (db.prepare('SELECT COUNT(*) n FROM settings').get().n === 0) {
    for (const [k, v] of Object.entries(SETTING_DEFAULTS)) setSetting(k, v);
  }
  if (db.prepare('SELECT COUNT(*) n FROM subscribers').get().n === 0) {
    const ins = db.prepare('INSERT INTO subscribers (email, created_at) VALUES (?,?)');
    [['ada@fieldnotes.example','2026-06-07T10:12:00.000Z'],['j.okafor@postbox.example','2026-07-19T18:40:00.000Z'],['riverside.bookclub@lists.example','2026-08-02T09:05:00.000Z'],['m.tanaka@readingroom.example','2026-09-23T21:33:00.000Z'],['the.librarian@stacks.example','2026-11-01T08:15:00.000Z']]
      .forEach(([e, d]) => ins.run(e, d));
  }
})();

/* ---------------- middleware ---------------- */
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0 }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(session({
  name: 'ld.sid', secret: SESSION_SECRET, store: new SqliteStore(db),
  resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 7 * 864e5, path: '/' }
}));
app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.siteName = app.locals.siteName;
  res.locals.settings = getSettings();
  res.locals.currentPath = req.path;
  res.locals.currentUrl = req.originalUrl;
  res.locals.isAdmin = !!req.session.isAdmin;
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;
  res.locals.pageTitle = ''; res.locals.bodyClass = ''; res.locals.pageDesc = '';
  res.locals.useEditor = false; res.locals.statusCode = 404; res.locals.message = '';
  const latest = db.prepare("SELECT slug FROM posts WHERE status='published' ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT 1").get();
  res.locals.latestSlug = latest ? latest.slug : null;
  res.locals.fmtDate = fmtDate; res.locals.dateParts = dateParts;
  res.locals.readMin = readMin; res.locals.wordCount = wordCount; res.locals.renderMd = renderMarkdown;
  res.locals.year = new Date().getUTCFullYear();
  next();
});
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const a = String(req.body.csrf || ''); const b = String(req.session.csrf || '');
  const ok = a.length > 0 && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (ok) return next();
  if (wantsJson(req)) return res.status(403).json({ ok: false, message: 'Your session expired — reload the page and try again.' });
  return res.status(403).render('404', { statusCode: 403, message: 'Your session expired. Go back, reload the page, and try again.' });
});

const loginHits = new Map();
function loginLock(ip) { const r = loginHits.get(ip); return r && r.until > Date.now() ? Math.ceil((r.until - Date.now()) / 60000) : 0; }
const subHits = new Map();
function subBlocked(ip) {
  const now = Date.now();
  const arr = (subHits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); subHits.set(ip, arr);
  return arr.length > 8;
}
function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

/* ---------------- public routes ---------------- */
app.get('/', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const per = 6;
  let where = "status='published'"; const params = [];
  if (q) {
    where += " AND (title LIKE ? ESCAPE '!' OR body LIKE ? ESCAPE '!')";
    const like = '%' + q.replace(/[!%_]/g, ch => '!' + ch) + '%';
    params.push(like, like);
  }
  const total = db.prepare('SELECT COUNT(*) n FROM posts WHERE ' + where).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / per));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const posts = db.prepare('SELECT * FROM posts WHERE ' + where + ' ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT ? OFFSET ?').all(...params, per, (page - 1) * per);
  const totalPublished = db.prepare("SELECT COUNT(*) n FROM posts WHERE status='published'").get().n;
  const bookCount = db.prepare('SELECT COUNT(*) n FROM books').get().n;
  const qs = new URLSearchParams(); if (q) qs.set('q', q);
  const s = qs.toString();
  res.render('index', { posts, q, total, page, pages, pageBase: '/?' + (s ? s + '&' : ''), totalPublished, bookCount });
});

app.get('/about', (req, res) => {
  const books = db.prepare('SELECT * FROM books ORDER BY sort_order ASC, id ASC').all();
  res.render('about', { books });
});

app.get('/posts/:slug', (req, res, next) => {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(req.params.slug);
  if (!post || (post.status !== 'published' && !req.session.isAdmin)) return next();
  const key = post.published_at || post.created_at;
  const newer = db.prepare("SELECT slug, title FROM posts WHERE status='published' AND COALESCE(published_at, created_at) > ? AND id != ? ORDER BY COALESCE(published_at, created_at) ASC, id ASC LIMIT 1").get(key, post.id);
  const older = db.prepare("SELECT slug, title FROM posts WHERE status='published' AND COALESCE(published_at, created_at) < ? AND id != ? ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT 1").get(key, post.id);
  res.render('post', { post, html: renderMarkdown(post.body), newer, older });
});

app.get('/feed.xml', (req, res) => {
  const base = req.protocol + '://' + req.get('host');
  const posts = db.prepare("SELECT * FROM posts WHERE status='published' ORDER BY COALESCE(published_at, created_at) DESC LIMIT 20").all();
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
    <description>${escapeXml(getSettings().tagline)}</description>
    <language>en</language>
${items}
  </channel>
</rss>`);
});

app.post('/subscribe', (req, res) => {
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
  const info = db.prepare('INSERT INTO subscribers (email, created_at) VALUES (?,?) ON CONFLICT(email) DO NOTHING').run(email, nowISO());
  return respond(true, info.changes ? "You're on the list. The next Margin will find you." : "You're already on the list — thank you for staying.");
});

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
  req.session.regenerate(err => {
    if (err) return res.status(500).render('login', { error: 'Could not sign in — please try again.', loggedOut: false });
    req.session.isAdmin = true;
    req.session.csrf = crypto.randomBytes(24).toString('hex');
    req.session.save(() => res.redirect('/admin'));
  });
});
app.use('/admin', requireAdmin);
app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('ld.sid'); res.redirect('/admin/login?bye=1'); });
});

/* ---------------- admin: posts ---------------- */
app.get('/admin', (req, res) => {
  const statusFilter = ['published', 'draft', 'trashed'].includes(req.query.status) ? req.query.status : 'all';
  const q = String(req.query.q || '').trim().slice(0, 80);
  const sortMap = { updated_desc: 'updated_at DESC, id DESC', created_desc: 'created_at DESC, id DESC', oldest: 'COALESCE(published_at, created_at) ASC, id ASC', title: 'title COLLATE NOCASE ASC' };
  const sort = sortMap[req.query.sort] ? req.query.sort : 'updated_desc';
  const where = []; const params = [];
  if (statusFilter === 'all') where.push("status != 'trashed'"); else { where.push('status = ?'); params.push(statusFilter); }
  if (q) {
    where.push("(title LIKE ? ESCAPE '!' OR body LIKE ? ESCAPE '!')");
    const like = '%' + q.replace(/[!%_]/g, ch => '!' + ch) + '%';
    params.push(like, like);
  }
  const w = where.join(' AND ');
  const per = 12;
  const total = db.prepare('SELECT COUNT(*) n FROM posts WHERE ' + w).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / per));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const posts = db.prepare('SELECT * FROM posts WHERE ' + w + ' ORDER BY ' + sortMap[sort] + ' LIMIT ? OFFSET ?').all(...params, per, (page - 1) * per);
  const counts = { published: 0, draft: 0, trashed: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM posts GROUP BY status').all()) counts[r.status] = r.n;
  const subscriberCount = db.prepare('SELECT COUNT(*) n FROM subscribers').get().n;
  const bookCount = db.prepare('SELECT COUNT(*) n FROM books').get().n;
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (statusFilter !== 'all') qs.set('status', statusFilter);
  if (sort !== 'updated_desc') qs.set('sort', sort);
  const s = qs.toString();
  res.render('dashboard', { posts, statusFilter, q, sort, page, pages, total, pageBase: '/admin?' + (s ? s + '&' : ''), counts, subscriberCount, bookCount });
});

app.get('/admin/posts/new', (req, res) => res.render('edit', { post: null, formError: null }));

function readPostForm(req) {
  const title = String(req.body.title || '').trim().slice(0, 200);
  const body = String(req.body.body || '');
  const excerpt = String(req.body.excerpt || '').trim().slice(0, 300);
  const status = req.body.status === 'published' ? 'published' : 'draft';
  if (!title || !body.trim()) return null;
  return { title, body, excerpt: excerpt || autoExcerpt(body), status, slugBase: slugify(String(req.body.slug || '') || title) };
}
app.post('/admin/posts', (req, res) => {
  const data = readPostForm(req);
  if (!data) return res.status(422).render('edit', { post: { id: null, title: req.body.title || '', slug: req.body.slug || '', excerpt: req.body.excerpt || '', body: req.body.body || '', status: 'draft', created_at: null, updated_at: null, published_at: null }, formError: 'A title and some text are required.' });
  const slug = uniqueSlug(data.slugBase);
  const now = nowISO();
  const info = db.prepare('INSERT INTO posts (title, slug, excerpt, body, status, created_at, updated_at, published_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(data.title, slug, data.excerpt, data.body, data.status, now, now, data.status === 'published' ? now : null);
  flash(req, 'ok', data.status === 'published' ? 'Published.' : 'Draft saved.', data.status === 'published' ? { label: 'View', url: '/posts/' + slug, method: 'get' } : null);
  res.redirect('/admin/posts/' + info.lastInsertRowid + '/edit');
});
app.get('/admin/posts/:id/edit', (req, res, next) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return next();
  if (post.status === 'trashed') { flash(req, 'info', 'Restore this post from the trash before editing it.'); return res.redirect('/admin?status=trashed'); }
  res.render('edit', { post, formError: null });
});
app.post('/admin/posts/:id', (req, res, next) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return next();
  if (post.status === 'trashed') { flash(req, 'err', 'Restore this post before editing.'); return res.redirect('/admin?status=trashed'); }
  const data = readPostForm(req);
  if (!data) return res.status(422).render('edit', { post: Object.assign({}, post, { title: req.body.title || '', slug: req.body.slug || '', excerpt: req.body.excerpt || '', body: req.body.body || '' }), formError: 'A title and some text are required.' });
  const slug = uniqueSlug(data.slugBase, post.id);
  const now = nowISO();
  const publishedAt = data.status === 'published' ? (post.published_at || now) : post.published_at;
  db.prepare('UPDATE posts SET title=?, slug=?, excerpt=?, body=?, status=?, updated_at=?, published_at=? WHERE id=?')
    .run(data.title, slug, data.excerpt, data.body, data.status, now, publishedAt, post.id);
  flash(req, 'ok', data.status === 'published' ? 'Saved and live.' : 'Saved as a draft.', data.status === 'published' ? { label: 'View', url: '/posts/' + slug, method: 'get' } : null);
  res.redirect('/admin/posts/' + post.id + '/edit');
});
app.post('/admin/posts/:id/trash', (req, res, next) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return next();
  db.prepare("UPDATE posts SET status='trashed', updated_at=? WHERE id=?").run(nowISO(), post.id);
  flash(req, 'info', '\u201C' + post.title + '\u201D moved to trash.', { label: 'Undo', url: '/admin/posts/' + post.id + '/restore', method: 'post' });
  res.redirect(safeBack(req.body.back, '/admin'));
});
app.post('/admin/posts/:id/restore', (req, res, next) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return next();
  db.prepare("UPDATE posts SET status='draft', updated_at=? WHERE id=?").run(nowISO(), post.id);
  flash(req, 'ok', '\u201C' + post.title + '\u201D restored as a draft.');
  res.redirect(safeBack(req.body.back, '/admin'));
});
app.post('/admin/posts/:id/destroy', (req, res, next) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return next();
  db.prepare("DELETE FROM posts WHERE id=? AND status='trashed'").run(post.id);
  flash(req, 'ok', 'Deleted for good.');
  res.redirect('/admin?status=trashed');
});
app.post('/admin/posts/empty-trash', (req, res) => {
  const info = db.prepare("DELETE FROM posts WHERE status='trashed'").run();
  flash(req, 'ok', info.changes + ' post' + (info.changes === 1 ? '' : 's') + ' deleted for good.');
  res.redirect('/admin?status=trashed');
});
app.post('/admin/posts/bulk', (req, res) => {
  let ids = req.body.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(n => parseInt(n, 10)).filter(Number.isInteger);
  const action = String(req.body.action || '');
  const now = nowISO();
  let n = 0;
  const run = db.transaction(() => {
    for (const id of ids) {
      let info = { changes: 0 };
      if (action === 'publish') info = db.prepare("UPDATE posts SET status='published', published_at=COALESCE(published_at, ?), updated_at=? WHERE id=? AND status!='trashed'").run(now, now, id);
      else if (action === 'draft') info = db.prepare("UPDATE posts SET status='draft', updated_at=? WHERE id=? AND status!='trashed'").run(now, id);
      else if (action === 'trash') info = db.prepare("UPDATE posts SET status='trashed', updated_at=? WHERE id=? AND status!='trashed'").run(now, id);
      else if (action === 'restore') info = db.prepare("UPDATE posts SET status='draft', updated_at=? WHERE id=? AND status='trashed'").run(now, id);
      else if (action === 'destroy') info = db.prepare("DELETE FROM posts WHERE id=? AND status='trashed'").run(id);
      n += info.changes;
    }
  });
  run();
  const verbs = { publish: 'published', draft: 'moved to drafts', trash: 'moved to trash', restore: 'restored as drafts', destroy: 'deleted for good' };
  flash(req, 'ok', n + ' post' + (n === 1 ? '' : 's') + ' ' + (verbs[action] || 'updated') + '.');
  res.redirect(safeBack(req.body.back, '/admin'));
});

/* ---------------- admin: books ---------------- */
function normalizeBookOrder() {
  const rows = db.prepare('SELECT id, sort_order FROM books ORDER BY sort_order ASC, id ASC').all();
  const upd = db.prepare('UPDATE books SET sort_order=? WHERE id=?');
  rows.forEach((r, i) => { if (r.sort_order !== i) upd.run(i, r.id); });
}
function readBookForm(req) {
  const title = String(req.body.title || '').trim().slice(0, 160);
  const subtitle = String(req.body.subtitle || '').trim().slice(0, 120);
  let year = parseInt(req.body.year, 10);
  year = Number.isInteger(year) && year >= 1400 && year <= 2100 ? year : null;
  const cover = String(req.body.cover || '').trim().slice(0, 300);
  const buyUrl = String(req.body.buy_url || '').trim().slice(0, 300);
  const blurb = String(req.body.blurb || '').trim().slice(0, 600);
  if (!title) return { error: 'A title is required.' };
  if (buyUrl && !/^https?:\/\/.+/i.test(buyUrl)) return { error: 'The buy link must start with http:// or https://.' };
  if (cover && !/^(\/|https?:\/\/)/i.test(cover)) return { error: 'The cover must be a path like /covers/my-book.svg or a full image URL.' };
  return { title, subtitle, year, cover, buyUrl, blurb };
}
app.get('/admin/books', (req, res) => {
  res.render('books', { books: db.prepare('SELECT * FROM books ORDER BY sort_order ASC, id ASC').all() });
});
app.get('/admin/books/new', (req, res) => res.render('book-edit', { book: null, formError: null }));
app.post('/admin/books', (req, res) => {
  const data = readBookForm(req);
  if (data.error) return res.status(422).render('book-edit', { book: Object.assign({ id: null }, req.body), formError: data.error });
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM books').get().m;
  db.prepare('INSERT INTO books (title, subtitle, year, cover, buy_url, blurb, sort_order) VALUES (?,?,?,?,?,?,?)')
    .run(data.title, data.subtitle, data.year, data.cover, data.buyUrl, data.blurb, max + 1);
  flash(req, 'ok', '\u201C' + data.title + '\u201D added to the shelf.', { label: 'View', url: '/about#books', method: 'get' });
  res.redirect('/admin/books');
});
app.get('/admin/books/:id/edit', (req, res, next) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return next();
  res.render('book-edit', { book, formError: null });
});
app.post('/admin/books/:id', (req, res, next) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return next();
  const data = readBookForm(req);
  if (data.error) return res.status(422).render('book-edit', { book: Object.assign({}, book, req.body), formError: data.error });
  db.prepare('UPDATE books SET title=?, subtitle=?, year=?, cover=?, buy_url=?, blurb=? WHERE id=?')
    .run(data.title, data.subtitle, data.year, data.cover, data.buyUrl, data.blurb, book.id);
  flash(req, 'ok', 'Book saved.', { label: 'View', url: '/about#books', method: 'get' });
  res.redirect('/admin/books');
});
app.post('/admin/books/:id/delete', (req, res, next) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return next();
  db.prepare('DELETE FROM books WHERE id=?').run(book.id);
  normalizeBookOrder();
  flash(req, 'ok', '\u201C' + book.title + '\u201D removed from the shelf.');
  res.redirect('/admin/books');
});
app.post('/admin/books/:id/move', (req, res, next) => {
  const rows = db.prepare('SELECT id FROM books ORDER BY sort_order ASC, id ASC').all();
  const idx = rows.findIndex(r => String(r.id) === String(req.params.id));
  if (idx === -1) return next();
  const swap = req.body.dir === 'up' ? idx - 1 : idx + 1;
  if (swap >= 0 && swap < rows.length) { [rows[idx], rows[swap]] = [rows[swap], rows[idx]]; }
  const upd = db.prepare('UPDATE books SET sort_order=? WHERE id=?');
  db.transaction(() => rows.forEach((r, i) => upd.run(i, r.id)))();
  res.redirect('/admin/books');
});
app.post('/admin/books/reorder', (req, res) => {
  let order = req.body.order || [];
  if (!Array.isArray(order)) order = [order];
  const upd = db.prepare('UPDATE books SET sort_order=? WHERE id=?');
  db.transaction(() => order.forEach((id, i) => upd.run(i, parseInt(id, 10))))();
  normalizeBookOrder();
  flash(req, 'ok', 'Shelf order saved.');
  res.redirect('/admin/books');
});

/* ---------------- admin: settings & subscribers ---------------- */
app.get('/admin/settings', (req, res) => res.render('settings', { formError: null }));
app.post('/admin/settings', (req, res) => {
  const authorName = String(req.body.authorName || '').trim().slice(0, 120);
  const tagline = String(req.body.tagline || '').trim().slice(0, 200);
  const location = String(req.body.location || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().slice(0, 254);
  const website = String(req.body.website || '').trim().slice(0, 300);
  const bio = String(req.body.bio || '').slice(0, 20000);
  if (!authorName) return res.status(422).render('settings', { formError: 'The author name is required.' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(422).render('settings', { formError: 'That contact email doesn\u2019t look right.' });
  if (website && !/^https?:\/\/.+/i.test(website)) return res.status(422).render('settings', { formError: 'The website must start with http:// or https://.' });
  setSetting('author_name', authorName); setSetting('tagline', tagline); setSetting('location', location);
  setSetting('email', email); setSetting('website', website); setSetting('bio', bio);
  flash(req, 'ok', 'Settings saved.', { label: 'View author page', url: '/about', method: 'get' });
  res.redirect('/admin/settings');
});
app.get('/admin/subscribers', (req, res) => {
  res.render('subscribers', { subscribers: db.prepare('SELECT * FROM subscribers ORDER BY created_at DESC, id DESC').all() });
});
app.get('/admin/subscribers.csv', (req, res) => {
  const rows = db.prepare('SELECT email, created_at FROM subscribers ORDER BY created_at ASC').all();
  const csv = 'email,subscribed_at\n' + rows.map(r => '"' + r.email.replace(/"/g, '""') + '","' + r.created_at + '"').join('\n');
  res.setHeader('Content-Disposition', 'attachment; filename="subscribers.csv"');
  res.type('text/csv').send(csv);
});
app.post('/admin/subscribers/:id/delete', (req, res, next) => {
  const row = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(req.params.id);
  if (!row) return next();
  db.prepare('DELETE FROM subscribers WHERE id=?').run(row.id);
  flash(req, 'ok', row.email + ' removed from the list.');
  res.redirect('/admin/subscribers');
});

/* ---------------- errors & boot ---------------- */
app.use((req, res) => res.status(404).render('404', { statusCode: 404, message: '' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).render('404', { statusCode: 500, message: 'The error has been logged. Try again in a moment.' });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(app.locals.siteName + ' \u2192 http://localhost:' + PORT + '  (desk: /admin)'));
