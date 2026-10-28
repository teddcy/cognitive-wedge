import nodemailer from 'nodemailer';
import { config } from './config.js';
import { run, all } from './db.js';
import { now } from './clock.js';

let transport;
const smtp = () => (config.smtpUrl ? (transport ||= nodemailer.createTransport(config.smtpUrl)) : null);

// Sends an email. Without SMTP_URL the message is stored and logged, and shown in /dev/outbox in dev mode.
export async function sendMail({ sessionId = null, to, kind, subject, text, link = null }) {
  const body = link ? `${text}\n\n${link}` : text;
  const info = run(
    'INSERT INTO emails (session_id,to_addr,kind,subject,body,link,created_at,delivered) VALUES (?,?,?,?,?,?,?,0)',
    sessionId, to, kind, subject, body, link, now(),
  );
  const t = smtp();
  if (t) {
    try {
      await t.sendMail({ from: config.mailFrom, to, subject, text: body });
      run('UPDATE emails SET delivered=1 WHERE id=?', info.lastInsertRowid);
    } catch (e) {
      console.error('mail failed:', e.message);
    }
  } else if (config.devMode) {
    console.log(`[mail:${kind}] to ${to}: ${link || subject}`);
  }
  return info.lastInsertRowid;
}

export const outbox = () => all('SELECT * FROM emails ORDER BY id DESC LIMIT 50');
