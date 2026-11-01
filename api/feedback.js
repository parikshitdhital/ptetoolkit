const GUIDE = require('./_guide.js');
const L = require('./_lib.js');

const MODELS = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || 'gemini-flash-latest,gemini-flash-lite-latest').split(',').map(x => x.trim()).filter(Boolean);
const DAILY_LIMIT = parseInt(process.env.FEEDBACK_DAILY_LIMIT || '10', 10);
const MAX = { content: 3, form: 2, dsc: 2, grammar: 2, glr: 2, vocab: 2, spelling: 2 };

const SYSTEM = `You are a friendly, encouraging PTE Academic essay coach. Your teacher created the guide below, which teaches ONE master template for every Write Essay question. Mark the student's essay according to THIS guide, and teach the guide through your feedback.

=== THE TEACHER'S GUIDE ===
${GUIDE}
=== END OF GUIDE ===

HOW TO MARK
1. Identify the correct essay type from the question's instruction words (not the topic). Say whether the student's essay matches that type.
2. Check the intro: (a) the topic phrase is a broad noun phrase that fits "... has become a subject of growing debate in recent times"; (b) the swap line matches the essay type; (c) there is a roadmap sentence.
3. Check each body paragraph for Point > Reason > Example > Mini-conclusion, with the guide's connectors. The two examples must be genuinely different.
4. Check the conclusion rephrases the intro (not copied) and ends with a forward-looking sentence.
5. Score the PTE traits: content 0-3, dsc (development, structure, coherence) 0-2, grammar 0-2, glr (general linguistic range) 0-2, vocab 0-2, spelling 0-2. Do NOT score form; the server does it from the word count. If the essay is off-topic, content is 0.
6. For each paragraph (Introduction, Body 1, Body 2, Conclusion) give an indicative mark out of 90 for that paragraph's quality, 2-4 short "worked" points, 2-4 "improve" points, and 1-3 "alternatives": better or more template-aligned sentences the student could have written, based on THEIR own ideas. If a paragraph is missing, give 0 and say so.

STYLE: speak directly to the student ("you"), warm and specific, simple English (the students are non-native speakers). Quote short phrases from their essay when pointing at problems. Never invent text the student did not write. Be honest: do not inflate marks.

OUTPUT: return ONLY valid JSON, no markdown, exactly this shape:
{
 "essay_type": "Opinion | Advantages & Disadvantages | Problem & Solution | Responsibility",
 "type_comment": "1-2 sentences: is the essay answering the right type?",
 "topic_phrase": {"student_wrote": "...", "verdict": "good | needs work | missing", "better_version": "..."},
 "criteria": {
   "content": {"score": 0, "comment": "..."},
   "dsc": {"score": 0, "comment": "..."},
   "grammar": {"score": 0, "comment": "..."},
   "glr": {"score": 0, "comment": "..."},
   "vocab": {"score": 0, "comment": "..."},
   "spelling": {"score": 0, "comment": "..."}
 },
 "paragraphs": [
   {"name": "Introduction", "score90": 0, "worked": ["..."], "improve": ["..."], "alternatives": ["..."]},
   {"name": "Body 1", "score90": 0, "worked": [], "improve": [], "alternatives": []},
   {"name": "Body 2", "score90": 0, "worked": [], "improve": [], "alternatives": []},
   {"name": "Conclusion", "score90": 0, "worked": [], "improve": [], "alternatives": []}
 ],
 "summary": "2-3 encouraging sentences",
 "top_fixes": ["the 3 most valuable things to fix next time"]
}`;

function clamp(n, max) { n = Math.round(Number(n)); return isNaN(n) ? 0 : Math.max(0, Math.min(max, n)); }
function formScore(w) { return (w >= 200 && w <= 300) ? 2 : ((w >= 120 && w <= 380) ? 1 : 0); }

const useKey = u => 'pte:fb:' + u + ':' + new Date().toISOString().slice(0, 10);
async function overLimit(redis, username) {
  try { return (Number(await redis.get(useKey(username))) || 0) >= DAILY_LIMIT; } catch (e) { return false; }
}
async function countUse(redis, username) {
  try { const n = await redis.incr(useKey(username)); if (n === 1) await redis.expire(useKey(username), 86400); } catch (e) {}
}

// Free-tier reliability: try each model in turn, retry a few rounds, stay inside Vercel's time limit
async function askGemini(payload) {
  const deadline = Date.now() + 52000;
  for (let round = 0; round < 4; round++) {
    for (const model of MODELS) {
      const left = deadline - Date.now();
      if (left < 5000) return { busy: true };
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), Math.min(25000, left));
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
          method: 'POST', signal: ctl.signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
          body: payload
        });
        if (r.status === 400 || r.status === 401 || r.status === 403)
          return { fatal: 'Google rejected the request (error ' + r.status + '). Check GEMINI_API_KEY in Vercel.' };
        if (!r.ok) continue;                       // 404, 429, 5xx: try the next model
        const data = await r.json();
        let txt = (((data.candidates || [])[0] || {}).content || {}).parts;
        txt = (txt || []).map(p => p.text || '').join('').replace(/```json|```/g, '').trim();
        return { fb: JSON.parse(txt) };
      } catch (e) { /* timeout, network problem or bad JSON: try again */ }
      finally { clearTimeout(timer); }
    }
    await new Promise(r => setTimeout(r, 1500 * (round + 1)));
  }
  return { busy: true };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    let redis;
    try { redis = L.getRedis(); } catch (e) { return res.status(500).json({ error: e.message }); }
    const student = await L.getStudent(req, redis);
    if (!student) return res.status(401).json({ error: 'Please log in again.', login: true });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel (add it, then redeploy)' });

    const question = String((req.body && req.body.question) || '').slice(0, 2000);
    const essay = String((req.body && req.body.essay) || '').trim().slice(0, 6000);
    const words = (essay.match(/\S+/g) || []).length;
    if (words < 20) return res.status(400).json({ error: 'Your essay is too short to mark. Write at least a few sentences.' });

    if (await overLimit(redis, student.username)) return res.status(429).json({ error: 'Daily feedback limit reached (' + DAILY_LIMIT + ' per day). Please try again tomorrow.' });

    const payload = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: 'QUESTION:\n' + question + '\n\nSTUDENT ESSAY (' + words + ' words):\n' + essay }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.3 }
    });
    const out = await askGemini(payload);
    if (out.fatal) return res.status(500).json({ error: out.fatal });
    if (out.busy) return res.status(503).json({ error: "The AI is very busy right now (Google's free servers are crowded). Your essay is safe on this page. Press Try again in a minute. This did not count against your daily limit." });
    const fb = out.fb;
    await countUse(redis, student.username);

    // Server-side scoring: form from word count, clamp the rest, total out of 90
    const c = fb.criteria || {};
    const sc = {};
    Object.keys(MAX).forEach(k => { sc[k] = k === 'form' ? formScore(words) : clamp((c[k] || {}).score, MAX[k]); });
    if (sc.content === 0) Object.keys(sc).forEach(k => { sc[k] = 0; });
    const raw = Object.values(sc).reduce((a, b) => a + b, 0);
    fb.criteria = fb.criteria || {};
    Object.keys(MAX).forEach(k => { fb.criteria[k] = Object.assign({}, fb.criteria[k], { score: sc[k], max: MAX[k] }); });
    fb.criteria.form.comment = words + ' words. ' + (sc.form === 2 ? 'Within the 200-300 range.' : 'The target is 200-300 words.');
    fb.word_count = words;
    fb.overall = Math.round((raw / 15) * 90);

    try {  // save to this student's history
      const attempt = { id: Date.now().toString(36), date: new Date().toISOString(), questionId: String((req.body && req.body.questionId) || ''), question, essay, words, overall: fb.overall, feedback: fb };
      await redis.lpush('pte:hist:' + student.username, attempt);
      await redis.ltrim('pte:hist:' + student.username, 0, 199);
      fb.attempt_id = attempt.id;
    } catch (e) { /* feedback still returned even if saving fails */ }
    return res.status(200).json(fb);
  } catch (e) {
    return res.status(500).json({ error: 'Could not read the AI response. Please try again.' });
  }
};
