const L = require('./_lib.js');
const USERS = 'pte:users';
const ROLES = ['student', 'teacher'];

module.exports = async (req, res) => {
  try {
    if (!process.env.TEACHER_PASSWORD) return res.status(500).json({ error: 'TEACHER_PASSWORD is not set in Vercel' });
    const redis = L.getRedis();
    const actor = await L.getActor(req, redis);
    if (!L.canManageContent(actor)) return res.status(401).json({ error: 'Not allowed' });
    const b = req.body || {};

    if (req.method === 'GET') {  // owner sees everyone, staff teachers see students only
      const all = (await redis.hgetall(USERS)) || {};
      const names = Object.keys(all).filter(n => L.isOwner(actor) || (all[n].role || 'student') === 'student').sort();
      const rows = await Promise.all(names.map(async n => {
        const cnt = await redis.llen('pte:hist:' + n);
        let last = null;
        if (cnt) { const a = await redis.lindex('pte:hist:' + n, 0); last = a && a.date; }
        return { username: n, name: all[n].name, role: all[n].role || 'student', created: all[n].created, attempts: cnt, last };
      }));
      return res.status(200).json({ students: rows });
    }

    // Everything below changes accounts: owner only
    if (!L.isOwner(actor)) return res.status(403).json({ error: 'Only the owner can create, change or delete accounts.' });

    if (req.method === 'POST') {
      const username = L.cleanUsername(b.username);
      const pw = String(b.password || '');
      const role = ROLES.includes(b.role) ? b.role : 'student';
      if (!username || username === 'owner') return res.status(400).json({ error: 'Username must be 3-30 characters: letters, numbers, dot, dash or underscore (and cannot be "owner").' });
      if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      if (await redis.hget(USERS, username)) return res.status(400).json({ error: 'That username already exists.' });
      const { salt, hash } = L.hashPw(pw);
      await redis.hset(USERS, { [username]: { username, name: String(b.name || '').trim().slice(0, 60) || username, role, salt, hash, created: new Date().toISOString() } });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'PUT') {
      const username = L.cleanUsername(b.username);
      const u = username && await redis.hget(USERS, username);
      if (!u) return res.status(404).json({ error: 'Account not found.' });
      const next = Object.assign({}, u);
      if (b.password !== undefined && b.password !== '') {
        if (String(b.password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        const { salt, hash } = L.hashPw(String(b.password));
        next.salt = salt; next.hash = hash;
      }
      if (ROLES.includes(b.role)) next.role = b.role;
      await redis.hset(USERS, { [username]: next });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const username = L.cleanUsername(req.query.username);
      if (!username) return res.status(400).json({ error: 'Bad username' });
      await redis.hdel(USERS, username);
      await redis.del('pte:hist:' + username);
      for (const t of ['swt', 'di', 'coll']) await redis.del('pte:prog:' + t + ':' + username);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
