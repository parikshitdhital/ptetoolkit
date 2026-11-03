const L = require('./_lib.js');

// Each tool saves its own kind of record. Unknown fields are dropped; text is length-limited.
const TOOLS = {
  swt:  { passageId: ['s', 60], passage: ['s', 120], text: ['s', 1500], words: ['n'] },
  di:   { imageId: ['s', 60], text: ['s', 2500], words: ['n'] },
  coll: { mode: ['s', 40], score: ['n'], total: ['n'], note: ['s', 300] },
};
const MAX_KEEP = 300;
const key = (t, u) => 'pte:prog:' + t + ':' + u;

function clean(tool, d) {
  const out = {};
  for (const [f, [type, max]] of Object.entries(TOOLS[tool])) {
    const v = d && d[f];
    if (type === 'n') out[f] = Math.max(0, Math.min(100000, Number(v) || 0));
    else out[f] = String(v == null ? '' : v).slice(0, max);
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    const redis = L.getRedis();
    const actor = await L.getActor(req, redis);
    if (!actor) return res.status(401).json({ error: 'Please log in again.', login: true });
    const tool = String(req.query.tool || (req.body && req.body.tool) || '');
    if (!TOOLS[tool]) return res.status(400).json({ error: 'Unknown tool' });

    // Whose records? Owner/teachers can look at a student's (?username=); everyone else only their own.
    let username;
    if (L.canManageContent(actor) && req.query.username) username = L.cleanUsername(req.query.username);
    else if (actor.role === 'owner') return res.status(400).json({ error: 'Choose a student first.' });
    else username = actor.username;
    if (!username) return res.status(400).json({ error: 'Bad username' });
    const k = key(tool, username);

    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ attempts: (await redis.lrange(k, 0, -1)) || [] });
    }

    if (req.method === 'POST') {  // saving is always to your OWN account
      if (username !== actor.username) return res.status(403).json({ error: 'You can only save to your own account.' });
      const rec = Object.assign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), date: new Date().toISOString() }, clean(tool, req.body && req.body.data));
      await redis.lpush(k, rec);
      await redis.ltrim(k, 0, MAX_KEEP - 1);
      return res.status(200).json({ ok: true, attempt: rec });
    }

    if (req.method === 'DELETE') {  // owner: anyone's; everyone else: only their own
      if (!(actor.role === 'owner' || username === actor.username)) return res.status(403).json({ error: 'You can only delete your own progress.' });
      if (req.query.all) { await redis.del(k); return res.status(200).json({ ok: true }); }
      const list = (await redis.lrange(k, 0, -1)) || [];
      const keep = list.filter(x => x.id !== req.query.id);
      if (keep.length === list.length) return res.status(404).json({ error: 'Not found' });
      await redis.del(k);
      if (keep.length) await redis.rpush(k, ...keep);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
module.exports.TOOLS = Object.keys(TOOLS);
