// Runs once a minute: resume emails, check-in emails, and the retention purge.
import { all, get, run, deleteParticipant } from './db.js';
import { now, MIN, HOUR, DAY } from './clock.js';
import { config, IDLE_MIN, RESUME_SECOND_AFTER_H } from './config.js';
import { sendResume } from './engine.js';
import { createToken } from './auth.js';
import { sendMail } from './mailer.js';

export async function tick() {
  const t = now();

  // Resume: after 30 minutes idle in any state before Reconstruction, then once more after 24 hours. No third.
  const idle = all(
    `SELECT * FROM sessions WHERE closed=0 AND state IN ('ORIENTATION','ONBOARDING','RUPTURE','DECONSTRUCTION')
     AND last_activity_at < ? AND resume_sent < 2`, t - IDLE_MIN * MIN);
  for (const s of idle) {
    if (s.resume_sent === 0) await sendResume(s.id);
    else if (s.last_resume_at && t - s.last_resume_at >= RESUME_SECOND_AFTER_H * HOUR) await sendResume(s.id);
  }

  // Check-ins: email the magic link on the scheduled day.
  const due = all(
    `SELECT c.*, s.participant_id FROM checkins c JOIN sessions s ON s.id=c.session_id
     WHERE c.sent_at IS NULL AND c.scheduled_for <= ? AND s.closed=0`, t);
  for (const c of due) await sendCheckin(c);

  // Retention: delete participants whose records are older than the retention period.
  if (config.retentionDays > 0) {
    const cutoff = t - config.retentionDays * DAY;
    for (const p of all('SELECT id FROM participants WHERE created_at < ?', cutoff)) deleteParticipant(p.id);
  }
}

export async function sendCheckin(c) {
  const p = get('SELECT * FROM participants WHERE id=?', c.participant_id);
  const token = createToken({ participantId: p.id, sessionId: c.session_id, purpose: 'checkin', day: c.day });
  await sendMail({
    sessionId: c.session_id, to: p.email, kind: `checkin_${c.day}`,
    subject: `Cognitive Wedge: your day ${c.day} check-in`,
    text: `It is time for your day ${c.day} check-in. It is short. Your tell-tale and your commitment will be waiting.`,
    link: `${config.baseUrl}/s/${token}`,
  });
  run('UPDATE checkins SET sent_at=? WHERE id=?', now(), c.id);
}

let timer;
export function startScheduler() {
  timer = setInterval(() => tick().catch((e) => console.error('scheduler:', e.message)), MIN);
  timer.unref?.();
}
export const stopScheduler = () => clearInterval(timer);
