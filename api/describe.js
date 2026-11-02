const L = require('./_lib.js');
const SECTIONS = 'pte:di:sections';   // JSON array of { label, sentences: [text] }
const META = 'pte:di:imgmeta';        // hash: id -> { id, title, created }
const DATA = 'pte:di:imgdata';        // hash: id -> data URL (compressed image)
const MAX_IMG = 450000;               // characters of data URL (images are shrunk in the browser first)

function cleanSections(input) {
  if (!Array.isArray(input) || !input.length || input.length > 10) return null;
  const out = [];
  for (const s of input) {
    const label = String((s && s.label) || '').trim().slice(0, 60);
    const sentences = (Array.isArray(s && s.sentences) ? s.sentences : [])
      .map(x => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 60);
    if (!label) return null;
    out.push({ label, sentences });
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    const redis = L.getRedis();

    // ---------- public reads (students need these) ----------
    if (req.method === 'GET') {
      if (req.query.img) {  // the picture itself
        const d = await redis.hget(DATA, String(req.query.img));
        const m = typeof d === 'string' && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(d);
        if (!m) return res.status(404).json({ error: 'Image not found' });
        res.setHeader('Content-Type', m[1]);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.statusCode = 200;
        return res.end(Buffer.from(m[2], 'base64'));
      }
      const sections = (await redis.get(SECTIONS)) || [];
      const meta = (await redis.hgetall(META)) || {};
      const images = Object.values(meta).sort((a, b) => String(a.created).localeCompare(String(b.created)))
        .map(i => ({ id: i.id, title: i.title || '' }));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ sections, images });
    }

    // ---------- everything below: owner or staff teacher ----------
    const actor = await L.getActor(req, redis);
    if (!L.canManageContent(actor)) return res.status(401).json({ error: 'Not allowed' });
    const b = req.body || {};

    if (req.method === 'POST') {
      if (b.action === 'sections_save') {
        const clean = cleanSections(b.sections);
        if (!clean) return res.status(400).json({ error: 'Each section needs a name, and there can be 1-10 sections.' });
        await redis.set(SECTIONS, clean);
        return res.status(200).json({ ok: true, sections: clean });
      }
      if (b.action === 'sections_reset') {
        await redis.del(SECTIONS);
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'image_add') {
        const data = String(b.data || '');
        if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) return res.status(400).json({ error: 'That is not a valid image.' });
        if (data.length > MAX_IMG) return res.status(400).json({ error: 'Image is too large even after shrinking. Try a smaller picture.' });
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await redis.hset(DATA, { [id]: data });
        await redis.hset(META, { [id]: { id, title: String(b.title || '').trim().slice(0, 80), created: new Date().toISOString() } });
        return res.status(200).json({ ok: true, id });
      }
      if (b.action === 'image_edit') {
        const m = await redis.hget(META, String(b.id || ''));
        if (!m) return res.status(404).json({ error: 'Image not found' });
        await redis.hset(META, { [m.id]: Object.assign({}, m, { title: String(b.title || '').trim().slice(0, 80) }) });
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'Unknown action' });
    }

    if (req.method === 'DELETE') {
      const id = String(req.query.img || '');
      if (!id) return res.status(400).json({ error: 'No image id' });
      await redis.hdel(META, id);
      await redis.hdel(DATA, id);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
