import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY, label TEXT, email TEXT UNIQUE NOT NULL, track TEXT NOT NULL,
  agent_name_seen TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, participant_id TEXT NOT NULL, format TEXT DEFAULT 'self_serve',
  state TEXT NOT NULL, state_entered_at INTEGER NOT NULL, state_active_ms INTEGER DEFAULT 0,
  gate_mode TEXT DEFAULT 'full', rev INTEGER DEFAULT 0, last_activity_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, closed INTEGER DEFAULT 0, exit_reason TEXT,
  checkin_day INTEGER, build_started_at INTEGER, build_active_ms INTEGER DEFAULT 0,
  nudge_sent INTEGER DEFAULT 0, resume_sent INTEGER DEFAULT 0, last_resume_at INTEGER,
  gate_retries INTEGER DEFAULT 0, idle_gap_max_min REAL DEFAULT 0, idle_seen INTEGER DEFAULT 0,
  resumed INTEGER DEFAULT 0, reached INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, module TEXT NOT NULL, state TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, meta TEXT);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL,
  data TEXT NOT NULL, prompt_version TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_records_session ON records(session_id, name, version);
CREATE TABLE IF NOT EXISTS state_timing (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, state TEXT NOT NULL,
  entered_at INTEGER NOT NULL, exited_at INTEGER, active_min REAL DEFAULT 0, budget_min REAL,
  gate_mode TEXT DEFAULT 'full', retries INTEGER DEFAULT 0, exit_reason TEXT,
  idle_gap_max_min REAL DEFAULT 0, build_minutes REAL);
CREATE TABLE IF NOT EXISTS classifier_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, module TEXT NOT NULL,
  attempt INTEGER, verdict TEXT, fallback INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS gate_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, state TEXT NOT NULL,
  kind TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, version INTEGER NOT NULL,
  checkpoint TEXT NOT NULL, generated_at INTEGER NOT NULL, snapshot TEXT NOT NULL, truncated TEXT);
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, day INTEGER NOT NULL,
  scheduled_for INTEGER NOT NULL, sent_at INTEGER, opened_at INTEGER, completed_at INTEGER);
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, checkpoint TEXT NOT NULL,
  rubric_version TEXT NOT NULL, computed_at INTEGER NOT NULL, total INTEGER, band TEXT, outlook TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY, participant_id TEXT, session_id TEXT, staff_email TEXT, purpose TEXT NOT NULL,
  day INTEGER, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, to_addr TEXT, kind TEXT, subject TEXT,
  body TEXT, link TEXT, created_at INTEGER, delivered INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, staff_email TEXT, participant_id TEXT, created_at INTEGER);
`;

export function openDb(file = config.dbPath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
  db.exec(SCHEMA);
  return db;
}

export const getDb = () => db;
export const uid = () => crypto.randomUUID();
export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function deleteParticipant(participantId) {
  transaction(() => {
    const sessions = all('SELECT id FROM sessions WHERE participant_id=?', participantId);
    for (const s of sessions) {
      for (const t of ['messages', 'records', 'state_timing', 'classifier_log', 'gate_log', 'reports', 'checkins', 'scores', 'emails']) {
        run(`DELETE FROM ${t} WHERE session_id=?`, s.id);
      }
      run('DELETE FROM tokens WHERE session_id=?', s.id);
    }
    run('DELETE FROM sessions WHERE participant_id=?', participantId);
    run('DELETE FROM tokens WHERE participant_id=?', participantId);
    run('DELETE FROM access_log WHERE participant_id=?', participantId);
    run('DELETE FROM participants WHERE id=?', participantId);
  });
}
