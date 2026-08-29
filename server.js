const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_ID = process.env.ADMIN_ID || '';
const isAdmin = (u) => !!ADMIN_ID && !!u && String(u.id) === String(ADMIN_ID);

// ---------- DB ----------
const dbFile = process.env.DB_PATH || path.join(ROOT, 'data.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    username TEXT,
    photo_url TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS ads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    price INTEGER NOT NULL,
    description TEXT DEFAULT '',
    city TEXT NOT NULL,
    tg TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS favorites (
    user_id TEXT NOT NULL,
    ad_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, ad_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ads_city ON ads(city);
`);
try { db.exec("ALTER TABLE ads ADD COLUMN images TEXT DEFAULT '[]'"); } catch (e) {}
try { db.exec("ALTER TABLE ads ADD COLUMN status TEXT DEFAULT 'active'"); } catch (e) {}
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    ad_id INTEGER NOT NULL,
    reason TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(user_id, ad_id)
  );
`);

// ---------- Telegram auth ----------
function validateInitData(initData) {
  if (!BOT_TOKEN) {
    // DEBUG mode: no bot token configured. Accept a mock user for local testing.
    if (initData) {
      try {
        const url = new URLSearchParams(initData);
        const raw = url.get('user');
        if (raw) return JSON.parse(decodeURIComponent(raw));
      } catch (e) {}
    }
    return { id: '0', first_name: 'Debug', username: 'debug' };
  }
  if (!initData) return null;
  try {
    const url = new URLSearchParams(initData);
    const hash = url.get('hash');
    if (!hash) return null;
    url.delete('hash');
    const dataCheckString = [...url.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computed !== hash) return null;
    const raw = url.get('user');
    const u = raw ? JSON.parse(decodeURIComponent(raw)) : { id: 0 };
    u.id = String(u.id);
    return u;
  } catch (e) {
    return null;
  }
}

function upsertUser(u) {
  db.prepare(
    `INSERT INTO users (id, first_name, last_name, username, photo_url)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       first_name=excluded.first_name, last_name=excluded.last_name,
       username=excluded.username, photo_url=excluded.photo_url`
  ).run(u.id, u.first_name || '', u.last_name || '', u.username || '', u.photo_url || '');
}

function getUser(u) {
  return db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
}

// ---------- Helpers ----------
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const uploadDir = path.join(path.dirname(dbFile), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

function saveImage(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  if (dataUrl.startsWith('/uploads/')) return dataUrl;
  if (!dataUrl.startsWith('data:image/')) return null;
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const sub = m[1].split('/')[1];
  const ext = sub === 'jpeg' ? 'jpg' : (sub === 'svg+xml' ? 'svg' : sub);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4 * 1024 * 1024) return null; // max 4MB per image
  const name = Date.now() + '_' + Math.random().toString(36).slice(2, 9) + '.' + ext;
  fs.writeFileSync(path.join(uploadDir, name), buf);
  return '/uploads/' + name;
}

function auth(req, res, next) {
  const init = req.header('X-Init-Data') || (req.body && req.body.initData) || '';
  const u = validateInitData(init);
  if (!u || u.id == null) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = u;
  upsertUser(u);
  next();
}

function mapAd(row, favIds, myId) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    price: row.price,
    description: row.description,
    city: row.city,
    tg: row.tg,
    phone: row.phone,
    images: row.images ? JSON.parse(row.images) : [],
    status: row.status || 'active',
    seller: row.first_name || 'Пользователь',
    fav: favIds ? favIds.has(row.id) : false,
    isMine: myId != null && String(row.user_id) === String(myId),
    createdAt: row.created_at,
  };
}

// ---------- API ----------
app.post('/api/auth', (req, res) => {
  const u = validateInitData(req.body && req.body.initData);
  if (!u || u.id == null) return res.status(401).json({ error: 'Unauthorized' });
  upsertUser(u);
  res.json({ user: getUser(u), debug: !BOT_TOKEN, isAdmin: isAdmin(u) });
});

app.get('/api/ads', auth, (req, res) => {
  const { city, q, category } = req.query;
  const favRows = db.prepare('SELECT ad_id FROM favorites WHERE user_id=?').all(req.user.id);
  const favIds = new Set(favRows.map(r => r.ad_id));

  let sql = `SELECT ads.*, users.first_name FROM ads JOIN users ON users.id = ads.user_id WHERE 1=1`;
  const params = [];
  if (city) { sql += ' AND ads.city=?'; params.push(city); }
  if (category) { sql += ' AND ads.category=?'; params.push(category); }
  if (q) { sql += ' AND (ads.title LIKE ? OR ads.description LIKE ?)'; params.push('%' + q + '%', '%' + q + '%'); }
  sql += " AND ads.status <> 'hidden'";
  sql += ' ORDER BY ads.created_at DESC LIMIT 100';
  const rows = db.prepare(sql).all(...params);
  res.json({ ads: rows.map(r => mapAd(r, favIds, req.user.id)), city: city || null });
});

app.get('/api/ads/:id', auth, (req, res) => {
  const favRows = db.prepare('SELECT ad_id FROM favorites WHERE user_id=?').all(req.user.id);
  const favIds = new Set(favRows.map(r => r.ad_id));
  const row = db.prepare('SELECT ads.*, users.first_name FROM ads JOIN users ON users.id = ads.user_id WHERE ads.id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status === 'hidden' && String(row.user_id) !== String(req.user.id) && !isAdmin(req.user)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ ad: mapAd(row, favIds, req.user.id) });
});

app.post('/api/ads', auth, (req, res) => {
  const { title, category, price, description, city, tg, phone, images } = req.body || {};
  if (!title || !category || !price || !city) {
    return res.status(400).json({ error: 'Заполните обязательные поля' });
  }
  let imgPaths = [];
  if (Array.isArray(images)) {
    imgPaths = images.slice(0, 8).map(saveImage).filter(Boolean);
  }
  const info = db.prepare(
    `INSERT INTO ads (user_id, title, category, price, description, city, tg, phone, images)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.user.id, String(title), String(category), Number(price), String(description || ''), String(city), String(tg || ''), String(phone || ''), JSON.stringify(imgPaths));
  const row = db.prepare('SELECT ads.*, users.first_name FROM ads JOIN users ON users.id = ads.user_id WHERE ads.id=?').get(info.lastInsertRowid);
  res.json({ ad: mapAd(row, new Set(), req.user.id) });
});

app.put('/api/ads/:id', auth, (req, res) => {
  const row = db.prepare('SELECT user_id FROM ads WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Не найдено' });
  if (String(row.user_id) !== String(req.user.id)) return res.status(403).json({ error: 'Это не ваше объявление' });
  const { title, category, price, description, city, tg, phone, images } = req.body || {};
  let imgPaths = [];
  if (Array.isArray(images)) imgPaths = images.slice(0, 8).map(saveImage).filter(Boolean);
  db.prepare(`UPDATE ads SET title=?, category=?, price=?, description=?, city=?, tg=?, phone=?, images=? WHERE id=?`)
    .run(String(title || ''), String(category || ''), Number(price || 0), String(description || ''), String(city || ''), String(tg || ''), String(phone || ''), JSON.stringify(imgPaths), req.params.id);
  const upd = db.prepare('SELECT ads.*, users.first_name FROM ads JOIN users ON users.id = ads.user_id WHERE ads.id=?').get(req.params.id);
  res.json({ ad: mapAd(upd, new Set(), req.user.id) });
});

app.delete('/api/ads/:id', auth, (req, res) => {
  const row = db.prepare('SELECT user_id FROM ads WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Не найдено' });
  if (String(row.user_id) !== String(req.user.id)) return res.status(403).json({ error: 'Это не ваше объявление' });
  db.prepare('DELETE FROM favorites WHERE ad_id=?').run(req.params.id);
  db.prepare('DELETE FROM ads WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/ads/:id/status', auth, (req, res) => {
  const row = db.prepare('SELECT user_id FROM ads WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Не найдено' });
  if (String(row.user_id) !== String(req.user.id)) return res.status(403).json({ error: 'Это не ваше объявление' });
  const st = (req.body && req.body.status === 'sold') ? 'sold' : 'active';
  db.prepare('UPDATE ads SET status=? WHERE id=?').run(st, req.params.id);
  res.json({ ok: true, status: st });
});

app.post('/api/report', auth, (req, res) => {
  const adId = Number(req.body && req.body.adId);
  const reason = (req.body && req.body.reason) || '';
  if (!adId) return res.status(400).json({ error: 'adId required' });
  const ad = db.prepare('SELECT user_id FROM ads WHERE id=?').get(adId);
  if (!ad) return res.status(404).json({ error: 'Не найдено' });
  if (String(ad.user_id) === String(req.user.id)) return res.status(400).json({ error: 'Нельзя пожаловаться на своё объявление' });
  db.prepare('INSERT OR IGNORE INTO reports (user_id, ad_id, reason) VALUES (?, ?, ?)').run(req.user.id, adId, String(reason).slice(0, 200));
  res.json({ ok: true });
});

app.post('/api/fav', auth, (req, res) => {
  const adId = Number(req.body && req.body.adId);
  if (!adId) return res.status(400).json({ error: 'adId required' });
  const exists = db.prepare('SELECT 1 FROM favorites WHERE user_id=? AND ad_id=?').get(req.user.id, adId);
  if (exists) {
    db.prepare('DELETE FROM favorites WHERE user_id=? AND ad_id=?').run(req.user.id, adId);
    return res.json({ fav: false });
  }
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, ad_id) VALUES (?, ?)').run(req.user.id, adId);
  res.json({ fav: true });
});

app.get('/api/me', auth, (req, res) => {
  const u = getUser(req.user);
  const myAds = db.prepare('SELECT ads.*, users.first_name FROM ads JOIN users ON users.id = ads.user_id WHERE ads.user_id=? ORDER BY ads.created_at DESC').all(req.user.id);
  const favRows = db.prepare('SELECT ad_id FROM favorites WHERE user_id=?').all(req.user.id);
  const favIds = new Set(favRows.map(r => r.ad_id));
  const favAds = db.prepare(
    `SELECT ads.*, users.first_name FROM ads JOIN users ON users.id = ads.user_id
     WHERE ads.id IN (${favIds.size ? [...favIds].map(() => '?').join(',') : 'NULL'})`
  ).all(...favIds);
  res.json({
    user: u,
    isAdmin: isAdmin(req.user),
    myAds: myAds.map(r => mapAd(r, favIds, req.user.id)),
    favAds: favAds.map(r => mapAd(r, favIds, req.user.id)),
    favCount: favIds.size,
  });
});

app.get('/api/admin/reports', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Нет доступа' });
  const rows = db.prepare(
    `SELECT r.id AS rid, r.reason, r.created_at, r.ad_id, a.title, a.city, a.status
     FROM reports r JOIN ads a ON a.id = r.ad_id
     ORDER BY r.created_at DESC`
  ).all();
  res.json({ reports: rows });
});

app.post('/api/admin/ads/:id', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Нет доступа' });
  const action = (req.body && req.body.action) || 'hide';
  if (action === 'delete') {
    db.prepare('DELETE FROM favorites WHERE ad_id=?').run(req.params.id);
    db.prepare('DELETE FROM ads WHERE id=?').run(req.params.id);
    db.prepare('DELETE FROM reports WHERE ad_id=?').run(req.params.id);
    return res.json({ ok: true, action: 'delete' });
  }
  db.prepare("UPDATE ads SET status='hidden' WHERE id=?").run(req.params.id);
  res.json({ ok: true, action: 'hide' });
});

app.get('/api/cities', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT city FROM ads ORDER BY city').all();
  res.json({ cities: rows.map(r => r.city) });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/uploads/')) {
    return res.sendFile(path.join(ROOT, 'public', 'index.html'));
  }
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Market API running on http://localhost:${PORT}`);
  if (!BOT_TOKEN) console.log('WARNING: BOT_TOKEN not set — running in DEBUG mode (no real Telegram auth).');
});
