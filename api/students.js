const L = require('./_lib.js');
const USERS = 'pte:users';

module.exports = async (req, res) => {
  try {
    if (!process.env.TEACHER_PASSWORD) return res.status(500).json({ error: 'TEACHER_PASSWORD is not set in Vercel' });
    if (!L.isTeacher(req)) return res.status(401).json({ error: 'Wrong teacher password' });
    const redis = L.getRedis();
    const b = req.body || {};

    if (req.method === 'GET') {
      const all = (await redis.hgetall(USERS)) || {};
      const rows = await Promise.all(Object.keys(all).sort().map(async n => {
        const cnt = await redis.llen('pte:hist:' + n);
        let last = null;
        if (cnt) { const a = await redis.lindex('pte:hist:' + n, 0); last = a && a.date; }
        return { username: n, name: all[n].name, created: all[n].created, attempts: cnt, last };
      }));
      return res.status(200).json({ students: rows });
    }

    if (req.method === 'POST') {  // create
      const username = L.cleanUsername(b.username);
      const pw = String(b.password || '');
      if (!username) return res.status(400).json({ error: 'Username must be 3-30 characters: letters, numbers, dot, dash or underscore.' });
      if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      if (await redis.hget(USERS, username)) return res.status(400).json({ error: 'That username already exists.' });
      const { salt, hash } = L.hashPw(pw);
      await redis.hset(USERS, { [username]: { username, name: String(b.name || '').trim().slice(0, 60) || username, salt, hash, created: new Date().toISOString() } });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'PUT') {  // reset password
      const username = L.cleanUsername(b.username);
      const pw = String(b.password || '');
      const u = username && await redis.hget(USERS, username);
      if (!u) return res.status(404).json({ error: 'Student not found.' });
      if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      const { salt, hash } = L.hashPw(pw);
      await redis.hset(USERS, { [username]: Object.assign({}, u, { salt, hash }) });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const username = L.cleanUsername(req.query.username);
      if (!username) return res.status(400).json({ error: 'Bad username' });
      await redis.hdel(USERS, username);
      await redis.del('pte:hist:' + username);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
