// Preflight server: the API (and, for local use, the client files in ../client).
// Database choice: MongoDB if MONGODB_URI is set, otherwise SQLite (built into Node 22.5+),
// otherwise a JSON file.
const http = require('http'), fs = require('fs'), path = require('path');

// Minimal .env loader (no dependency). Real environment variables win.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) {}

const PORT = process.env.PORT || 3000;
const CLIENT = path.join(__dirname, '..', 'client');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');

async function openStore() {
  if (process.env.MONGODB_URI) {
    let MongoClient;
    try { ({ MongoClient } = require('mongodb')); }
    catch (e) { throw new Error('MONGODB_URI is set but the "mongodb" package is missing. Run: npm install'); }
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const col = client.db(process.env.MONGODB_DB || 'preflight').collection('plans');
    return {
      name: 'MongoDB',
      get: async w => { const d = await col.findOne({ _id: w }); return d ? JSON.stringify({ risks: d.risks, hist: d.hist, t: d.t }) : null; },
      set: async (w, json) => { const p = JSON.parse(json); await col.updateOne({ _id: w }, { $set: { risks: p.risks, hist: p.hist, t: p.t, updatedAt: new Date() } }, { upsert: true }); }
    };
  }
  fs.mkdirSync(DATA, { recursive: true });
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(DATA, 'preflight.db'));
    db.exec('CREATE TABLE IF NOT EXISTS plans (workspace TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    const get = db.prepare('SELECT data FROM plans WHERE workspace = ?');
    const set = db.prepare('INSERT INTO plans (workspace, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at');
    return { name: 'SQLite', get: async w => (get.get(w) || {}).data || null, set: async (w, d) => { set.run(w, d, Date.now()); } };
  } catch (_) {
    const file = path.join(DATA, 'preflight.json');
    let all = {};
    try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (__) {}
    return { name: 'JSON file', get: async w => all[w] || null, set: async (w, d) => { all[w] = d; fs.writeFileSync(file, JSON.stringify(all)); } };
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': process.env.CLIENT_ORIGIN || '*', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(body); };

openStore().then(store => {
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (url.pathname === '/api/plan') {
      const w = url.searchParams.get('w') || '';
      if (!/^[a-zA-Z0-9-]{8,64}$/.test(w)) return send(res, 400, '{"error":"bad workspace"}');
      try {
        if (req.method === 'GET') return send(res, 200, (await store.get(w)) || '{}');
        if (req.method === 'PUT') {
          let size = 0; const chunks = [];
          req.on('data', c => { size += c.length; if (size > 1e6) { send(res, 413, '{"error":"too large"}'); req.destroy(); } else chunks.push(c); });
          req.on('end', async () => {
            try {
              const d = JSON.parse(Buffer.concat(chunks).toString());
              if (!d || !Array.isArray(d.risks)) throw new SyntaxError('shape');
              await store.set(w, JSON.stringify({ risks: d.risks, hist: Array.isArray(d.hist) ? d.hist : [], t: Date.now() }));
              send(res, 200, '{"ok":true}');
            } catch (e) { send(res, e instanceof SyntaxError ? 400 : 500, JSON.stringify({ error: e instanceof SyntaxError ? 'invalid plan' : 'database error' })); }
          });
          return;
        }
        return send(res, 405, '{"error":"method not allowed"}');
      } catch (e) { return send(res, 500, '{"error":"database error"}'); }
    }
    const p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    if (p !== '/index.html' && p !== '/config.js') return send(res, 404, 'Not found', 'text/plain');
    const f = path.join(CLIENT, p);
    if (!f.startsWith(CLIENT)) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(f, (err, buf) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, TYPES[path.extname(f)] || 'application/octet-stream'));
  }).listen(PORT, () => console.log('Preflight running at http://localhost:' + PORT + ' (database: ' + store.name + ')'));
}).catch(e => { console.error('Could not start: ' + e.message); process.exit(1); });
