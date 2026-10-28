import crypto from 'node:crypto';
import { all, get, run, sha, uid } from './db.js';
import { config } from './config.js';
import { now, DAY, HOUR, MIN } from './clock.js';

const rand = () => crypto.randomBytes(32).toString('base64url');

export function createToken({ participantId = null, sessionId = null, staffEmail = null, purpose, day = null, ttlMs = 30 * DAY }) {
  const token = rand();
  run(
    'INSERT INTO tokens (hash,participant_id,session_id,staff_email,purpose,day,expires_at) VALUES (?,?,?,?,?,?,?)',
    sha(token), participantId, sessionId, staffEmail, purpose, day, now() + ttlMs,
  );
  return token;
}

// Participant links stay valid until they expire so a resume or check-in email can be opened more than once.
export function redeemToken(token) {
  const row = get('SELECT * FROM tokens WHERE hash=?', sha(String(token)));
  if (!row || row.expires_at < now()) return null;
  if (row.purpose === 'staff') {
    if (row.used_at) return null; // staff links are single use
    run('UPDATE tokens SET used_at=? WHERE hash=?', now(), row.hash);
  }
  return row;
}

export function startAuthSession(kind, subject, ttlMs) {
  const id = rand();
  run('INSERT INTO auth_sessions (id,kind,subject,expires_at) VALUES (?,?,?,?)', id, kind, subject, now() + ttlMs);
  return id;
}

export const PARTICIPANT_TTL = 30 * DAY;
export const STAFF_TTL = 8 * HOUR;

export function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, ttlMs) {
  const secure = config.baseUrl.startsWith('https') ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}${secure}`);
}
export const clearCookie = (res, name) => res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

function authFrom(req, cookieName, kind) {
  const id = readCookies(req)[cookieName];
  if (!id) return null;
  const row = get('SELECT * FROM auth_sessions WHERE id=? AND kind=?', id, kind);
  if (!row || row.expires_at < now()) return null;
  return row;
}

export function requireParticipant(req, res, next) {
  const a = authFrom(req, 'wid', 'participant');
  if (!a) return res.status(401).json({ error: 'not_signed_in' });
  req.participantId = a.subject;
  next();
}

export function requireStaff(req, res, next) {
  const a = authFrom(req, 'wst', 'staff');
  if (!a || !config.staffEmails.includes(a.subject)) {
    if (req.accepts('html') && !req.path.startsWith('/api/')) return res.redirect('/staff/login');
    return res.status(401).json({ error: 'staff_only' });
  }
  req.staffEmail = a.subject;
  next();
}

// Light in-memory rate limit for the email forms.
const hits = new Map();
export function limited(key, max = 5, windowMs = HOUR) {
  const t = Date.now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= max) return true;
  arr.push(t);
  hits.set(key, arr);
  return false;
}

export { all, MIN };
