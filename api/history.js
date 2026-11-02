const L = require('./_lib.js');

module.exports = async (req, res) => {
  try {
    const redis = L.getRedis();
    const actor = await L.getActor(req, redis);
    if (!actor) return res.status(401).json({ error: 'Please log in again.' });

    // Whose history? Owner/teachers may look at a student's (?username=), everyone else sees only their own
    let username;
    if (L.canManageContent(actor) && req.query.username) username = L.cleanUsername(req.query.username);
    else if (actor.role === 'owner') return res.status(400).json({ error: 'Choose a student first.' });
    else username = actor.username;
    if (!username) return res.status(400).json({ error: 'Bad username' });
    const key = 'pte:hist:' + username;

    if (req.method === 'GET') {
      const list = (await redis.lrange(key, 0, -1)) || [];
      if (req.query.id) {
        const a = list.find(x => x.id === req.query.id);
        return a ? res.status(200).json({ attempt: a }) : res.status(404).json({ error: 'Attempt not found' });
      }
      return res.status(200).json({
        attempts: list.map(a => ({ id: a.id, date: a.date, question: String(a.question || '').slice(0, 140), words: a.words, overall: a.overall }))
      });
    }

    if (req.method === 'DELETE') {  // owner: anyone's; everyone else: only their own
      if (!(actor.role === 'owner' || username === actor.username))
        return res.status(403).json({ error: 'You can only delete your own history.' });
      if (req.query.all) { await redis.del(key); return res.status(200).json({ ok: true }); }
      const list = (await redis.lrange(key, 0, -1)) || [];
      const keep = list.filter(x => x.id !== req.query.id);
      if (keep.length === list.length) return res.status(404).json({ error: 'Attempt not found' });
      await redis.del(key);
      if (keep.length) await redis.rpush(key, ...keep);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
