import { all, get, run } from './db.js';
import { now } from './clock.js';
import { PROMPT_VERSION } from './config.js';

const ALIASES = {
  'belief_ledger[0]': 'belief_ledger_0',
  belief_ledger: 'belief_ledger_0',
  declaredtask: 'declared_task',
  witnesscard: 'witness_card',
};

// Pull ```record fences out of an agent reply. Returns visible text and parsed objects.
export function extractRecords(raw) {
  const records = [];
  const errors = [];
  const re = /```record[ \t]*\r?\n([\s\S]*?)```/gi;
  const visible = raw
    .replace(re, (_, body) => {
      try {
        const obj = JSON.parse(body.trim());
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) records.push(obj);
        else errors.push('record block is not a JSON object');
      } catch (e) {
        errors.push('record block is not valid JSON');
      }
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { visible, records, errors };
}

export function normalizeName(k) {
  const key = String(k).trim();
  return ALIASES[key] || ALIASES[key.toLowerCase()] || key;
}

export function saveRecord(sessionId, name, data) {
  const n = normalizeName(name);
  const row = get('SELECT MAX(version) v FROM records WHERE session_id=? AND name=?', sessionId, n);
  const version = (row?.v || 0) + 1;
  run(
    'INSERT INTO records (session_id,name,version,data,prompt_version,created_at) VALUES (?,?,?,?,?,?)',
    sessionId, n, version, JSON.stringify(data), PROMPT_VERSION, now(),
  );
  return version;
}

// Latest version of each record, as { name: data }.
export function latestRecords(sessionId) {
  const rows = all(
    `SELECT r.name, r.data FROM records r
     JOIN (SELECT name, MAX(version) v FROM records WHERE session_id=? GROUP BY name) m
       ON m.name=r.name AND m.v=r.version WHERE r.session_id=?`,
    sessionId, sessionId,
  );
  const out = {};
  for (const r of rows) out[r.name] = JSON.parse(r.data);
  return out;
}

export function recordHistory(sessionId, name) {
  return all('SELECT version,data,created_at FROM records WHERE session_id=? AND name=? ORDER BY version', sessionId, name)
    .map((r) => ({ version: r.version, data: JSON.parse(r.data), created_at: r.created_at }));
}

export const wordCount = (s) => (typeof s === 'string' ? s.trim().split(/\s+/).filter(Boolean).length : 0);
export const textOf = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? (v.text ?? v.value ?? '') : String(v));
