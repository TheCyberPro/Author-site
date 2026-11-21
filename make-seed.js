// Usage: node make-seed.js server.old.js
// Reads the demo content (posts, books, settings, subscribers) out of your CURRENT server.js
// and writes seed.json, so the new server can start with exactly the same data.
const fs = require('fs'), vm = require('vm');
const file = process.argv[2] || 'server.old.js';
const src = fs.readFileSync(file, 'utf8');
const defs = src.match(/const SETTING_DEFAULTS = \{[\s\S]*?\n\};/);
const seed = src.match(/\(function seed\(\) \{[\s\S]*?\n\}\)\(\);/);
if (!defs || !seed) { console.error('Could not find SETTING_DEFAULTS and seed() in ' + file); process.exit(1); }
const out = { defaults: null, posts: [], books: [], settings: [], subscribers: [] };
const slugify = x => String(x || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const ctx = {
  slugify, uniqueSlug: b => b, nowISO: () => new Date().toISOString(),
  setSetting: (k, v) => out.settings.push([k, String(v == null ? '' : v)]),
  db: { prepare: sql => ({ get: () => ({ n: 0 }), all: () => [], run: (...a) => { const m = /INTO (\w+)/.exec(sql); if (m && Array.isArray(out[m[1]])) out[m[1]].push(a); return { changes: 1 }; } }) }
};
out.defaults = vm.runInNewContext(defs[0] + '\n' + seed[0] + '\n;SETTING_DEFAULTS', ctx);
fs.writeFileSync('seed.json', JSON.stringify(out, null, 1));
console.log('seed.json written: ' + out.posts.length + ' posts, ' + out.books.length + ' books, ' + out.settings.length + ' settings, ' + out.subscribers.length + ' subscribers');
