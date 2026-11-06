// Shared Gemini caller for the free tier: tries each model in turn, retries, stays inside Vercel's time limit,
// and tells us WHY it failed (overloaded servers vs. usage/quota limits) so students get a clear message.
const MODELS = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || 'gemini-flash-latest,gemini-flash-lite-latest').split(',').map(x => x.trim()).filter(Boolean);

// Google's free daily quota resets at midnight Pacific time
function nextPacificMidnight(now) {
  now = now || new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now).map(p => [p.type, p.value]));
  const sinceMidnight = (((+parts.hour % 24) * 60 + +parts.minute) * 60 + +parts.second) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() + 86400000 - sinceMidnight);
}
function nextUtcMidnight(now) { const d = new Date(now || Date.now()); d.setUTCHours(24, 0, 0, 0); return d; }

function classify(status, text) {
  let j = {}; try { j = JSON.parse(text); } catch (e) {}
  const err = j.error || {};
  const blob = String(err.message || text || '') + ' ' + JSON.stringify(err.details || []);
  if (status === 429 || err.status === 'RESOURCE_EXHAUSTED') {
    const m = /"retryDelay":"(\d+(?:\.\d+)?)s"/.exec(blob);
    return { cause: /PerDay|per day|daily/i.test(blob) ? 'daily_quota' : 'rate_limit', retryAfterSec: m ? Math.ceil(parseFloat(m[1])) : null };
  }
  if (status === 400 || status === 401 || status === 403) return { fatal: true, status };
  if (status === 404) return { cause: 'model' };
  return { cause: 'overloaded' };   // 500, 502, 503, 504 ...
}

// What to tell the student: the cause, and when to try again
function failure(cause, retryAfterSec) {
  const now = Date.now(); let retryAt;
  if (cause === 'daily_quota') retryAt = nextPacificMidnight(new Date(now));
  else if (cause === 'student_cap') retryAt = nextUtcMidnight(now);
  else if (cause === 'rate_limit') retryAt = new Date(now + Math.max(60, retryAfterSec || 60) * 1000);
  else retryAt = new Date(now + 10 * 60 * 1000);   // overloaded: a few minutes is usually enough
  return { cause, retryAt: retryAt.toISOString(), retryAfterSec: Math.round((retryAt.getTime() - now) / 1000) };
}
const MESSAGES = {
  overloaded: "Server overload: Google's free AI servers are very busy right now.",
  rate_limit: 'Usage limit (per minute): too many AI requests are being sent at the moment.',
  daily_quota: "Usage limit reached: the free AI's daily token quota is used up for today.",
  student_cap: 'Your daily AI feedback limit has been reached.',
  model: 'The AI model is not available right now.',
  key: 'The AI service is not set up correctly.'
};

async function askGemini(payload, opts) {
  opts = opts || {};
  const deadline = Date.now() + (opts.deadlineMs || 40000), rounds = opts.rounds || 3;
  const seen = new Set(); let retryAfter = null;
  for (let round = 0; round < rounds; round++) {
    for (const model of MODELS) {
      const left = deadline - Date.now();
      if (left < 5000) return pick(seen, retryAfter);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), Math.min(20000, left));
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
          method: 'POST', signal: ctl.signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
          body: payload
        });
        if (!r.ok) {
          const c = classify(r.status, await r.text().catch(() => ''));
          if (c.fatal) return { fatal: true, cause: 'key', status: c.status };
          seen.add(c.cause); if (c.retryAfterSec) retryAfter = Math.max(retryAfter || 0, c.retryAfterSec);
          continue;
        }
        const data = await r.json();
        let txt = (((data.candidates || [])[0] || {}).content || {}).parts;
        txt = (txt || []).map(p => p.text || '').join('').replace(/```json|```/g, '').trim();
        return { json: JSON.parse(txt) };
      } catch (e) { seen.add('overloaded'); /* timeout, network problem or bad JSON */ }
      finally { clearTimeout(timer); }
    }
    await new Promise(r => setTimeout(r, 1200 * (round + 1)));
  }
  return pick(seen, retryAfter);
}
// If several models failed for different reasons, report the one most likely to clear up soon
function pick(seen, retryAfter) {
  const cause = ['rate_limit', 'overloaded', 'daily_quota', 'model'].find(c => seen.has(c)) || 'overloaded';
  return Object.assign({ busy: true }, failure(cause, retryAfter));
}
module.exports = { askGemini, failure, MESSAGES, nextPacificMidnight, nextUtcMidnight };
