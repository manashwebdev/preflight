// Vercel serverless function: the same /api/plan API as server.js, backed by MongoDB.
let pending = null;
function plans() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  if (!pending) {
    const { MongoClient } = require('mongodb');
    pending = new MongoClient(process.env.MONGODB_URI).connect()
      .then(c => c.db(process.env.MONGODB_DB || 'preflight').collection('plans'))
      .catch(e => { pending = null; throw e; });
  }
  return pending;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', process.env.CLIENT_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const w = String((req.query && req.query.w) || '');
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(w)) return res.status(400).json({ error: 'bad workspace' });
  try {
    if (req.method === 'GET') {
      const d = await (await plans()).findOne({ _id: w });
      return res.status(200).json(d ? { risks: d.risks, hist: d.hist, t: d.t } : {});
    }
    if (req.method === 'PUT') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!b || !Array.isArray(b.risks) || JSON.stringify(b).length > 1e6) return res.status(400).json({ error: 'invalid plan' });
      await (await plans()).updateOne({ _id: w }, { $set: { risks: b.risks, hist: Array.isArray(b.hist) ? b.hist : [], t: Date.now(), updatedAt: new Date() } }, { upsert: true });
      return res.status(200).json({ ok: true });
    }
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message === 'MONGODB_URI is not set' ? e.message : 'database error' });
  }
};
