const L = require('./_lib.js');
const G = require('./_gemini.js');
const DAILY_LIMIT = parseInt(process.env.SWT_DAILY_LIMIT || '15', 10);
const JOINERS = ['and', 'but', 'while', 'whereas'];

/* ───────────── rule-based checks (no AI needed) ───────────── */
const norm = s => String(s == null ? '' : s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ').trim();
const wordsOf = s => (String(s).match(/\S+/g) || []);
const lw = s => wordsOf(s).map(w => w.toLowerCase().replace(/[^a-z0-9']/g, ''));

function sentencesOf(passage) {
  const m = norm(passage).match(/[^.!?]+(?:[.!?]+|$)/g) || [];
  return m.map(x => x.trim().replace(/[.!?]+$/, '').trim()).filter(x => x.split(' ').length >= 3);
}
function lcsSim(a, b) {
  const x = lw(a), y = lw(b); if (!x.length || !y.length) return 0;
  const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++)
    dp[i][j] = x[i - 1] === y[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[x.length][y.length] / Math.max(x.length, y.length);
}

function analyze(passage, answerRaw) {
  const text = norm(answerRaw);
  const wc = wordsOf(text).length;
  const sents = sentencesOf(passage).sort((a, b) => b.length - a.length);
  const issues = [];
  const add = (id, message, def, adjustable, extra) => issues.push(Object.assign({ id, message, deduction: def, adjustable: !!adjustable }, extra || {}));

  // final punctuation
  if (!/\.$/.test(text)) add('end_stop', 'The answer should end with one full stop.', 0.5, true);
  else if (/\.{2,}$/.test(text)) add('end_stop', 'End with a single full stop, not several.', 0.5, true);
  const body = text.replace(/[.!?]+$/, '');

  // walk through the answer, matching it against the passage sentences
  let pos = 0, guard = 0; const segs = [];
  while (pos < body.length && guard++ < 25) {
    const rest = body.slice(pos); let hit = null;
    for (const s of sents) {
      if (rest.length >= s.length && rest[0].toLowerCase() === s[0].toLowerCase() && rest.slice(1, s.length) === s.slice(1)) {
        const nxt = rest.slice(s.length);
        if (nxt === '' || /^[\s,;.]/.test(nxt)) { hit = s; break; }
      }
    }
    let segText, kind = 'exact', closest = null, sim = 1;
    if (hit) segText = rest.slice(0, hit.length);   // the student's own text (keeps their capitalisation)
    else {
      const m = /,\s*(and|but|while|whereas)\s+/i.exec(rest.slice(1));
      segText = m ? rest.slice(0, m.index + 1) : rest;
      sim = 0; closest = null; for (const s of sents) { const v = lcsSim(segText, s); if (v > sim) { sim = v; closest = s; } }
      kind = sim >= 0.8 ? 'near' : 'other';
    }
    const seg = { text: segText, kind, closest: kind === 'exact' ? null : closest, similarity: Math.round(sim * 100) / 100, startsUpper: /^[A-Z]/.test(segText), joiner: null, comma: null };
    segs.push(seg); pos += segText.length;
    const r2 = body.slice(pos); if (!r2.trim()) break;
    let jm;
    if ((jm = /^(\s*,)?\s*(and|but|while|whereas)\s+/i.exec(r2))) { seg.joiner = jm[2].toLowerCase(); seg.comma = !!jm[1]; pos += jm[0].length; continue; }
    if ((jm = /^\s*,\s*([A-Za-z]+)\s+/.exec(r2))) { seg.joiner = jm[1].toLowerCase(); seg.comma = true; seg.otherJoiner = true; pos += jm[0].length; continue; }
    if ((jm = /^\s*;\s*/.exec(r2))) { seg.semicolon = true; pos += jm[0].length; continue; }
    if ((jm = /^\s*\.\s*/.exec(r2))) { seg.stopAfter = true; pos += jm[0].length; continue; }
    seg.noJoiner = true; pos += r2.match(/^\s*/)[0].length;
  }

  // full stops inside the answer (ignoring ones that belong to copied passage sentences)
  const innerStops = (body.match(/\.(?!\d)/g) || []).length;
  const allowed = segs.filter(s => s.kind === 'exact').reduce((n, s) => n + (s.text.match(/\.(?!\d)/g) || []).length, 0);
  if (innerStops - allowed > 0) add('mid_stop', 'There is a full stop in the middle. This makes it more than one sentence and loses the Form mark.', 1.0, false);

  // word count
  if (wc > 75) add('too_long', 'Over 75 words: the Form mark is lost.', 1.0, false);
  else if (wc > 70) add('long', 'A bit long (' + wc + ' words). 50-70 is safest.', 0.5, true);
  if (wc < 40) add('too_short', 'Too short (' + wc + ' words). Aim for 50-70.', 1.0, false);
  else if (wc < 50) add('short', 'A bit short (' + wc + ' words). 50-70 is safest.', 0.5, true);

  if (segs.length && !segs[0].startsUpper) add('cap_first', 'Start the answer with a capital letter.', 0.5, true);
  segs.forEach((s, i) => {
    const n = i + 1;
    if (i > 0 && s.startsUpper && !segs[i - 1].stopAfter) {
      const w = (s.text.match(/^\S+/) || [''])[0];
      add('cap_' + n, 'Sentence ' + n + ' starts with a capital ("' + w + '"). After a joining word, make its first letter small.', 0.5, true, { maybeExempt: true });
    }
    if (s.kind === 'near') add('near_' + n, 'Sentence ' + n + ' is almost, but not exactly, the passage sentence (some words were changed).', 0.5, true, { closest: s.closest });
    if (s.kind === 'other') add('own_' + n, 'Sentence ' + n + ' is not a sentence from the passage.', 1.0, true, { closest: s.closest });
    if (s.joiner && s.comma === false) add('comma_' + n, 'Put a comma before the joining word "' + s.joiner + '".', 0.5, true);
    if (s.otherJoiner) add('joiner_' + n, '"' + s.joiner + '" is not one of your method words (and / but / while / whereas).', 0.5, true);
    if (s.semicolon) add('semi_' + n, 'Use a comma and a joining word instead of a semicolon.', 1.0, false);
    if (s.noJoiner) add('nojoin_' + n, 'Sentences must be joined with a comma and a joining word.', 1.0, false);
  });

  const covered = segs.filter(s => s.kind !== 'other').reduce((n, s) => n + wordsOf(s.text).length, 0);
  const mode = (segs.length && wc && covered / wc >= 0.7) ? 'method' : 'fair';
  return { text, wc, segs, issues, mode, joiners: segs.map(s => s.joiner).filter(Boolean) };
}

const roundHalf = n => Math.round(n * 2) / 2;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));

function strengthsOf(a) {
  const out = [];
  const ex = a.segs.filter(s => s.kind === 'exact').length;
  if (ex) out.push(ex === a.segs.length ? 'All ' + ex + ' sentence' + (ex > 1 ? 's were' : ' was') + ' copied exactly from the passage.' : ex + ' of ' + a.segs.length + ' sentences were copied exactly from the passage.');
  if (a.joiners.length && !a.issues.some(i => /^(joiner|nojoin|semi)_/.test(i.id))) out.push('Joining words used correctly: ' + a.joiners.join(', ') + '.');
  if (a.wc >= 50 && a.wc <= 70) out.push('Word count (' + a.wc + ') is in the ideal 50-70 range.');
  if (!a.issues.some(i => ['mid_stop', 'end_stop', 'cap_first'].includes(i.id))) out.push('Punctuation follows the method: one sentence with one full stop at the end.');
  return out;
}

/* ───────────── the AI part ───────────── */
const SYSTEM = `You are a friendly PTE coach checking a "Summarize Written Text" answer. The teacher's METHOD, which works very well in the real test:
1) Pick one full, independent sentence from the passage and write it exactly as it is.
2) Replace its ending full stop with a comma.
3) Add a joining word (and / but / while / whereas).
4) Add another sentence from the passage with its first letter lowercased.
Repeat until 50-70 words. Capitalise the very first letter, end with ONE full stop, never use a full stop in the middle.

The server already checked the answer by rules and gives you FACTS. Treat the facts as correct. Your job:
- mode "method" (the answer is built from passage sentences): decide "joining_deduction": 0 if the joining words suit the meaning of the two sentences (and = adds, but/whereas = contrast, while = contrast or parallel) AND the chosen sentences capture the passage's main ideas; 0.5 if the joining words clearly do not fit or the chosen sentences miss the main idea. For each server issue with adjustable=true, give a "deduction" between 0.5 and 1.0 depending on how serious it is (a tiny change = 0.5, a changed meaning = 1.0). If an issue has maybeExempt=true and the capital letter belongs to a proper noun, acronym or "I", give deduction 0 and say why.
- mode "fair" (the answer is NOT built from passage sentences): judge fairly like the real PTE. Give "traits": content 0-4 (covers the main points accurately, one sentence), grammar 0-2, vocab 0-2. Do not score form (server does).
Write warm, short, simple English for non-native learners. Never invent text. Return ONLY JSON:
{"joining_deduction":0,"issue_adjustments":[{"id":"cap_2","deduction":0.5,"why":"short reason"}],"strengths":["..."],"suggestions":["..."],"traits":{"content":0,"grammar":0,"vocab":0},"better_version":"(fair mode: one improved answer in the method style using exact passage sentences; method mode: leave empty)","summary":"1-2 encouraging sentences"}`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    let redis;
    try { redis = L.getRedis(); } catch (e) { return res.status(500).json({ error: e.message }); }
    const student = await L.getStudent(req, redis);
    if (!student) return res.status(401).json({ error: 'Please log in again.', login: true });

    const b = req.body || {};
    const key = 'pte:prog:swt:' + student.username;
    let passage = String((b.passage && b.passage.text) || '').slice(0, 6000);
    let title = String((b.passage && b.passage.title) || '').slice(0, 120);
    let passageId = String((b.passage && b.passage.id) || '').slice(0, 60);
    let answer = String(b.answer || '').trim().slice(0, 1500);
    let existing = null;
    const attemptId = String(b.attemptId || '').slice(0, 40);
    if (attemptId) {   // re-submit of an answer that was saved while the AI was unavailable
      existing = await L.findRecord(redis, key, attemptId);
      if (!existing) return res.status(404).json({ error: 'That saved answer was not found (it may have been deleted).' });
      if (existing.fb) return res.status(200).json(Object.assign({}, existing.fb, { attempt_id: existing.id }));
      passage = existing.passageText || ''; title = existing.passage || ''; passageId = existing.passageId || ''; answer = existing.text || '';
    }
    if (passage.length < 50) return res.status(400).json({ error: 'Passage missing.' });
    if (wordsOf(answer).length < 3) return res.status(400).json({ error: 'Write your summary first.' });

    // When the AI cannot check the answer, it is saved to the student's account right away
    const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const pend = async (info, status) => {
      const rec = { id: existing ? existing.id : newId, date: existing ? existing.date : new Date().toISOString(), passageId, passage: title, passageText: passage, text: answer, words: wordsOf(answer).length, status: 'pending', reason: info.cause, retryAt: info.retryAt || null, lastTry: new Date().toISOString() };
      let saved = false;
      try { await L.putRecord(redis, key, rec, existing ? existing.id : null, 300); saved = true; } catch (e) {}
      return res.status(status).json({ error: G.MESSAGES[info.cause], cause: info.cause, retryAt: info.retryAt || null, retryAfterSec: info.retryAfterSec || null, limit: DAILY_LIMIT, saved, attempt_id: rec.id });
    };

    const useKey = 'pte:fb:swt:' + student.username + ':' + new Date().toISOString().slice(0, 10);
    let capped = false;
    try { capped = (Number(await redis.get(useKey)) || 0) >= DAILY_LIMIT; } catch (e) {}
    if (capped) return pend(G.failure('student_cap'), 429);

    const a = analyze(passage, answer);
    let ai = null, aiDown = false, failInfo = { cause: 'key' };
    if (process.env.GEMINI_API_KEY) {
      const facts = { mode: a.mode, wordCount: a.wc, segments: a.segs.map(s => ({ text: s.text, kind: s.kind, joinerAfter: s.joiner, closestPassageSentence: s.closest })), issues: a.issues.map(i => ({ id: i.id, message: i.message, adjustable: i.adjustable, maybeExempt: !!i.maybeExempt })) };
      const out = await G.askGemini(JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: 'PASSAGE:\n' + passage + '\n\nSTUDENT ANSWER:\n' + answer + '\n\nFACTS:\n' + JSON.stringify(facts) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.3 }
      }));
      if (out.json) ai = out.json; else { aiDown = true; failInfo = out.busy ? out : { cause: 'key' }; }
    } else aiDown = true;

    if (a.mode === 'fair' && !ai) return pend(failInfo, failInfo.cause === 'key' ? 500 : 503);   // saved; free-style answers need the AI

    // ── final score (out of 9) ──
    const adj = {}; ((ai && ai.issue_adjustments) || []).forEach(x => { if (x && x.id) adj[x.id] = x; });
    const issues = a.issues.map(i => {
      let d = i.deduction, why = '';
      const x = adj[i.id];
      if (x && i.adjustable) {
        const v = Number(x.deduction);
        if (i.maybeExempt && v === 0) d = 0; else if (!isNaN(v)) d = clamp(v, 0.5, 1.0);
        why = String(x.why || '').slice(0, 200);
      }
      return { id: i.id, message: i.message, deduction: d, why };
    }).filter(i => i.deduction > 0 || i.why);
    let score, traits = null, joinDeduction = 0;
    const formOk = a.wc >= 5 && a.wc <= 75 && !a.issues.some(i => i.id === 'mid_stop');
    if (a.mode === 'method') {
      joinDeduction = ai ? (Number(ai.joining_deduction) >= 0.25 ? 0.5 : 0) : 0;
      score = clamp(roundHalf(9 - joinDeduction - issues.reduce((n, i) => n + i.deduction, 0)), 0, 9);
    } else {
      const t = (ai && ai.traits) || {};
      traits = { content: clamp(Math.round(t.content), 0, 4), form: formOk ? 1 : 0, grammar: clamp(Math.round(t.grammar), 0, 2), vocab: clamp(Math.round(t.vocab), 0, 2) };
      if (traits.content === 0) traits = { content: 0, form: 0, grammar: 0, vocab: 0 };
      score = traits.content + traits.form + traits.grammar + traits.vocab;
    }

    const fb = {
      mode: a.mode, score, wordCount: a.wc, ai: !aiDown,
      strengths: strengthsOf(a).concat(((ai && ai.strengths) || []).map(x => String(x).slice(0, 200)).slice(0, 3)),
      issues,
      joining_deduction: joinDeduction,
      suggestions: ((ai && ai.suggestions) || []).map(x => String(x).slice(0, 220)).slice(0, 4),
      traits, better_version: a.mode === 'fair' ? String((ai && ai.better_version) || '').slice(0, 800) : '',
      summary: String((ai && ai.summary) || (aiDown ? 'The AI was unavailable, so this is the rule-based check of your method.' : '')).slice(0, 400)
    };
    if (aiDown && a.mode === 'method') fb.suggestions = a.issues.slice(0, 4).map(i => i.message);

    try { await redis.incr(useKey); await redis.expire(useKey, 86400); } catch (e) {}
    try {
      const rec = { id: existing ? existing.id : newId, date: existing ? existing.date : new Date().toISOString(), passageId, passage: title, text: answer, words: a.wc, score, status: 'done', fb };
      await L.putRecord(redis, key, rec, existing ? existing.id : null, 300);
      fb.attempt_id = rec.id;
    } catch (e) { /* the report is still returned */ }
    return res.status(200).json(fb);
  } catch (e) {
    return res.status(500).json({ error: 'Could not check the answer. Please try again.' });
  }
};
module.exports.analyze = analyze;
