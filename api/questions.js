const KEY = 'pte:essay:questions';

function isTeacher(req) {
  const pw = process.env.TEACHER_PASSWORD;
  return !!pw && req.headers['x-teacher-password'] === pw;
}

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN missing in Vercel (add them, then redeploy)');
  let Redis;
  try { ({ Redis } = require('@upstash/redis')); }
  catch (e) { throw new Error('Database library not installed: package.json is missing from the repo root'); }
  return new Redis({ url, token });
}

module.exports = async (req, res) => {
  try {
    if (!process.env.TEACHER_PASSWORD) {
      return res.status(500).json({ error: 'TEACHER_PASSWORD is not set in Vercel (add it, then redeploy)' });
    }

    // Login check happens first, so it works even before the database is connected
    if (req.method === 'GET' && req.query.auth) {
      return isTeacher(req)
        ? res.status(200).json({ ok: true })
        : res.status(401).json({ error: 'Wrong password' });
    }

    if (req.method !== 'GET' && !isTeacher(req)) {
      return res.status(401).json({ error: 'Wrong teacher password' });
    }

    const redis = getRedis();
    let list = (await redis.get(KEY)) || [];

    if (req.method === 'GET') return res.status(200).json({ questions: list });

    if (req.method === 'POST') {
      const texts = ((req.body && req.body.texts) || [])
        .map(t => String(t).trim()).filter(Boolean);
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
