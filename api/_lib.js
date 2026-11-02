const crypto = require('crypto');

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN missing in Vercel (add them, then redeploy)');
  let Redis;
  try { ({ Redis } = require('@upstash/redis')); }
  catch (e) { throw new Error('Database library not installed: package.json is missing from the repo root'); }
  return new Redis({ url, token });
}

const isTeacher = req => !!process.env.TEACHER_PASSWORD && req.headers['x-teacher-password'] === process.env.TEACHER_PASSWORD;
const secret = () => process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('ptk:' + (process.env.UPSTASH_REDIS_REST_TOKEN || '')).digest('hex');

function hashPw(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
function checkPw(pw, u) {
  const h = crypto.scryptSync(pw, u.salt, 32), b = Buffer.from(u.hash, 'hex');
  return h.length === b.length && crypto.timingSafeEqual(h, b);
}

function sign(p) {
  const b = Buffer.from(JSON.stringify(p)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', secret()).update(b).digest('base64url');
}
function verify(t) {
  const [b, s] = String(t).split('.');
  if (!b || !s) return null;
  const good = crypto.createHmac('sha256', secret()).update(b).digest('base64url');
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try { const p = JSON.parse(Buffer.from(b, 'base64url').toString()); return p.exp > Date.now() ? p : null; }
  catch (e) { return null; }
}

// Returns the student record if the Bearer token is valid, the account exists, and the password has not changed since
async function getStudent(req, redis) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const p = verify(m[1]);
  if (!p) return null;
  const u = await redis.hget('pte:users', p.u);
  return (u && u.hash.slice(0, 12) === p.pv) ? u : null;
}

function cleanUsername(s) {
  s = String(s || '').trim().toLowerCase();
  return /^[a-z0-9._-]{3,30}$/.test(s) ? s : null;
}

// Who is calling? Owner (TEACHER_PASSWORD header) or a logged-in account with a role ('student' by default)
async function getActor(req, redis) {
  if (isTeacher(req)) return { role: 'owner', username: 'owner', name: 'Owner' };
  const u = await getStudent(req, redis);
  return u ? { role: u.role || 'student', username: u.username, name: u.name } : null;
}
const isOwner = a => !!a && a.role === 'owner';
const canManageContent = a => !!a && (a.role === 'owner' || a.role === 'teacher');

module.exports = { getRedis, isTeacher, hashPw, checkPw, sign, verify, getStudent, cleanUsername, getActor, isOwner, canManageContent };
