const L = require('./_lib.js');
const KEY = 'pte:essay:questions';

module.exports = async (req, res) => {
  try {
    const redis = L.getRedis();

    // Login check for the teacher panel (owner password OR staff teacher token)
    if (req.method === 'GET' && req.query.auth) {
      if (!process.env.TEACHER_PASSWORD) return res.status(500).json({ error: 'TEACHER_PASSWORD is not set in Vercel (add it, then redeploy)' });
      const a = await L.getActor(req, redis);
      return L.canManageContent(a) ? res.status(200).json({ ok: true, role: a.role })
                                   : res.status(401).json({ error: 'Wrong password' });
    }

    if (req.method !== 'GET') {
      const a = await L.getActor(req, redis);
      if (!L.canManageContent(a)) return res.status(401).json({ error: 'Not allowed' });
    }

    let list = (await redis.get(KEY)) || [];

    if (req.method === 'GET') return res.status(200).json({ questions: list });

    if (req.method === 'POST') {
      const texts = ((req.body && req.body.texts) || []).map(t => String(t).trim()).filter(Boolean);
      if (!texts.length) return res.status(400).json({ error: 'No question text' });
      texts.forEach((t, i) => list.push({ id: Date.now().toString(36) + i, text: t.slice(0, 2000) }));
      await redis.set(KEY, list);
      return res.status(200).json({ questions: list });
    }

    if (req.method === 'DELETE') {
      list = list.filter(q => q.id !== req.query.id);
      await redis.set(KEY, list);
      return res.status(200).json({ questions: list });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
