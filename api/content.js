const L = require('./_lib.js');

// Which tools can store teacher-managed items, and what fields each item may have
const TOOLS = {
  swt: { title: { max: 100 }, text: { max: 6000, required: true } },   // Summarize Written Text passages
};
const MAX_ITEMS = 300;
const key = t => 'pte:content:' + t;

function clean(tool, input) {
  const out = {};
  for (const [f, rule] of Object.entries(TOOLS[tool])) {
    const v = String((input && input[f]) || '').trim().slice(0, rule.max);
    if (rule.required && !v) return null;
    out[f] = v;
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    const redis = L.getRedis();
    const tool = String(req.query.tool || (req.body && req.body.tool) || '');
    if (!TOOLS[tool]) return res.status(400).json({ error: 'Unknown tool' });

    let list = (await redis.get(key(tool))) || [];

    if (req.method === 'GET') {  // students read the list
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ items: list });
    }

    const actor = await L.getActor(req, redis);
    if (!L.canManageContent(actor)) return res.status(401).json({ error: 'Not allowed' });
    const b = req.body || {};

    if (req.method === 'POST') {  // add one ({item}) or many ({items}, used for the one-time import)
      const incoming = Array.isArray(b.items) ? b.items : [b.item];
      const cleaned = incoming.map(i => clean(tool, i));
      if (!cleaned.length || cleaned.includes(null)) return res.status(400).json({ error: 'Please fill in the required text.' });
      if (list.length + cleaned.length > MAX_ITEMS) return res.status(400).json({ error: 'Too many items (limit ' + MAX_ITEMS + ').' });
      cleaned.forEach((c, i) => list.push(Object.assign({ id: Date.now().toString(36) + i + Math.random().toString(36).slice(2, 5), created: new Date().toISOString() }, c)));
      await redis.set(key(tool), list);
      return res.status(200).json({ items: list });
    }

    if (req.method === 'PUT') {
      const c = clean(tool, b.item);
      if (!c) return res.status(400).json({ error: 'Please fill in the required text.' });
      const i = list.findIndex(x => x.id === b.id);
      if (i < 0) return res.status(404).json({ error: 'Item not found' });
      list[i] = Object.assign({}, list[i], c);
      await redis.set(key(tool), list);
      return res.status(200).json({ items: list });
    }

    if (req.method === 'DELETE') {
      list = list.filter(x => x.id !== req.query.id);
      await redis.set(key(tool), list);
      return res.status(200).json({ items: list });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
