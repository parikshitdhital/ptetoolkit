const L = require('./_lib.js');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const redis = L.getRedis();
    let username;
    if (L.isTeacher(req) && req.query.username) username = L.cleanUsername(req.query.username);
    else {
      const u = await L.getStudent(req, redis);
      if (!u) return res.status(401).json({ error: 'Please log in again.' });
      username = u.username;
    }
    if (!username) return res.status(400).json({ error: 'Bad username' });

    const list = (await redis.lrange('pte:hist:' + username, 0, -1)) || [];
    if (req.query.id) {
      const a = list.find(x => x.id === req.query.id);
      return a ? res.status(200).json({ attempt: a }) : res.status(404).json({ error: 'Attempt not found' });
    }
    return res.status(200).json({
      attempts: list.map(a => ({ id: a.id, date: a.date, question: String(a.question || '').slice(0, 140), words: a.words, overall: a.overall }))
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
