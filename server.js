const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('Start with: ADMIN_PASSWORD="your-password" node server.js');
  process.exit(1);
}
const adminHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);

const app = express();
const db = new Database('site.db');

db.exec(`CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

const slugify = (t) =>
  t.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'post';

const requireAuth = (req, res, next) =>
  req.session.admin ? next() : res.redirect('/admin/login');

// ---------- Public ----------
app.get('/', (req, res) => {
  const posts = db.prepare('SELECT * FROM posts ORDER BY id DESC').all();
  res.render('index', { posts });
});

app.get('/post/:slug', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(req.params.slug);
  if (!post) return res.status(404).send('Not found');
  res.render('post', { post });
});

// ---------- Admin ----------
app.get('/admin/login', (req, res) => res.render('login', { error: null }));

app.post('/admin/login', (req, res) => {
  if (bcrypt.compareSync(req.body.password || '', adminHash)) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.status(401).render('login', { error: 'Wrong password' });
});

app.post('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/admin', requireAuth, (req, res) => {
  const posts = db.prepare('SELECT * FROM posts ORDER BY id DESC').all();
  res.render('dashboard', { posts });
});

app.get('/admin/new', requireAuth, (req, res) =>
  res.render('edit', { post: { title: '', body: '' }, action:
cat > views/login.ejs << 'EOF'
<link rel="stylesheet" href="/style.css">
<main>
  <h1>Admin login</h1>
  <% if (error) { %><p class="error"><%= error %></p><% } %>
  <form method="post" action="/admin/login">
    <input type="password" name="password" placeholder="Password" autofocus>
    <button>Log in</button>
  </form>
</main>
