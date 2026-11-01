const L = require('./_lib.js');

module.exports = async (req, res) => {
  try {
    const redis = L.getRedis();

    if (req.method === 'GET') {  // "am I still logged in?"
      const u = await L.getStudent(req, redis);
      return u ? res.status(200).json({ ok: true, name: u.name, username: u.username })
               : res.status(401).json({ error: 'Not logged in' });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const username = L.cleanUsername(req.body && req.body.username);
    const pw = String((req.body && req.body.password) || '');
    const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
    const fk = 'pte:lf:' + ip + ':' + (username || 'x');

    if ((Number(await redis.get(fk)) || 0) >= 10)
      return res.status(429).json({ error: 'Too many wrong attempts. Please wait 15 minutes.' });

    const u = username ? await redis.hget('pte:users', username) : null;
    if (!u || !L.checkPw(pw, u)) {
      const n = await redis.incr(fk);
      if (n === 1) await redis.expire(fk, 900);
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    await redis.del(fk);
    const token = L.sign({ u: u.username, pv: u.hash.slice(0, 12), exp: Date.now() + 30 * 864e5 });
    return res.status(200).json({ token, name: u.name, username: u.username });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
