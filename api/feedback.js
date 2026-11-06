const GUIDE = require('./_guide.js');
const L = require('./_lib.js');
const G = require('./_gemini.js');

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
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    let redis;
    try { redis = L.getRedis(); } catch (e) { return res.status(500).json({ error: e.message }); }
    const student = await L.getStudent(req, redis);
    if (!student) return res.status(401).json({ error: 'Please log in again.', login: true });
    const key = 'pte:hist:' + student.username;
    const body = req.body || {};

    // Either a brand-new essay, or a re-submit of one that was saved while the AI was unavailable
    let question = String(body.question || '').slice(0, 2000), essay = String(body.essay || '').trim().slice(0, 6000);
    let questionId = String(body.questionId || '').slice(0, 60), existing = null;
    const attemptId = String(body.attemptId || '').slice(0, 40);
    if (attemptId) {
      existing = await L.findRecord(redis, key, attemptId);
      if (!existing) return res.status(404).json({ error: 'That saved essay was not found (it may have been deleted).' });
      if (existing.feedback) return res.status(200).json(Object.assign({}, existing.feedback, { attempt_id: existing.id }));
      question = existing.question; essay = existing.essay; questionId = existing.questionId || '';
    }
    const words = (essay.match(/\S+/g) || []).length;
    if (words < 20) return res.status(400).json({ error: 'Your essay is too short to mark. Write at least a few sentences.' });

    // When the AI cannot answer, the essay is saved to the student's history right away
    const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const pend = async (info, status) => {
      const rec = { id: existing ? existing.id : newId, date: existing ? existing.date : new Date().toISOString(), questionId, question, essay, words, status: 'pending', reason: info.cause, retryAt: info.retryAt || null, lastTry: new Date().toISOString() };
      let saved = false;
      try { await L.putRecord(redis, key, rec, existing ? existing.id : null, 200); saved = true; } catch (e) {}
      return res.status(status).json({ error: G.MESSAGES[info.cause], cause: info.cause, retryAt: info.retryAt || null, retryAfterSec: info.retryAfterSec || null, limit: DAILY_LIMIT, saved, attempt_id: rec.id });
    };

    if (!process.env.GEMINI_API_KEY) return pend({ cause: 'key' }, 500);
    if (await overLimit(redis, student.username)) return pend(G.failure('student_cap'), 429);

    const payload = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: 'QUESTION:\n' + question + '\n\nSTUDENT ESSAY (' + words + ' words):\n' + essay }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.3 }
    });
    const out = await G.askGemini(payload, { deadlineMs: 50000, rounds: 4 });
    if (out.fatal) return pend({ cause: 'key' }, 500);
    if (out.busy) return pend(out, 503);
    const fb = out.json;
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

    try {  // save (or complete the pending record) in this student's history
      const attempt = { id: existing ? existing.id : newId, date: existing ? existing.date : new Date().toISOString(), questionId, question, essay, words, overall: fb.overall, status: 'done', feedback: fb };
      await L.putRecord(redis, key, attempt, existing ? existing.id : null, 200);
      fb.attempt_id = attempt.id;
    } catch (e) { /* feedback still returned even if saving fails */ }
    return res.status(200).json(fb);
  } catch (e) {
    return res.status(500).json({ error: 'Could not read the AI response. Please try again.' });
  }
};
