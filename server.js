import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { openDb, get, all, run, deleteParticipant } from './src/db.js';
import { advance, now, MIN, HOUR, DAY } from './src/clock.js';
import {
  createToken, redeemToken, startAuthSession, readCookies, setCookie, clearCookie,
  requireParticipant, requireStaff, limited, PARTICIPANT_TTL, STAFF_TTL,
} from './src/auth.js';
import {
  createParticipant, createSession, sessionForParticipant, handleUserMessage, summary, transcript,
  openCheckin, sendResume, getSession,
} from './src/engine.js';
import { sendMail, outbox } from './src/mailer.js';
import { renderStored, reportVersions } from './src/report.js';
import { dashboardData, participantDetail } from './src/staff-data.js';
import { startScheduler, tick } from './src/scheduler.js';
import { usingMock } from './src/llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = (f) => path.join(here, 'public', f);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    next();
  });
  app.use('/assets', express.static(path.join(here, 'public', 'assets'), { maxAge: '1h' }));

  app.get('/healthz', (req, res) => res.json({ ok: true, mock: usingMock(), dev: config.devMode }));

  // ---------- participant ----------
  app.get('/', (req, res) => res.sendFile(pub('index.html')));
  app.get('/chat', (req, res) => res.sendFile(pub('chat.html')));
  app.get('/config.json', (req, res) => res.json({ agentName: config.agentName, dev: config.devMode, mock: usingMock() }));

  app.post('/api/start', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const track = req.body?.track === 'personal' ? 'personal' : 'commercial';
    if (!EMAIL.test(email)) return res.status(400).json({ error: 'bad_email' });
    if (limited(`ip:${req.ip}`, 20) || limited(`mail:${email}`, 5)) return res.status(429).json({ error: 'slow_down' });
    const p = createParticipant(email, track);
    let s = sessionForParticipant(p.id);
    if (!s) s = getSession(createSession(p.id));
    const token = createToken({ participantId: p.id, sessionId: s.id, purpose: 'start' });
    const link = `${config.baseUrl}/s/${token}`;
    await sendMail({ sessionId: s.id, to: email, kind: 'start', subject: 'Your Cognitive Wedge link', text: 'Use this link to start, or to pick up where you left off.', link });
    res.json({ ok: true, ...(config.devMode ? { devLink: link } : {}) });
  });

  app.get('/s/:token', async (req, res) => {
    const t = redeemToken(req.params.token);
    if (!t || t.purpose === 'staff') return res.status(400).send('This link is not valid or has expired. Request a new one from the start page.');
    const id = startAuthSession('participant', t.participant_id, PARTICIPANT_TTL);
    setCookie(res, 'wid', id, PARTICIPANT_TTL);
    try {
      if (t.purpose === 'checkin') await openCheckin(t.session_id, t.day);
    } catch (e) { console.error('openCheckin:', e.message); }
    res.redirect('/chat');
  });

  app.get('/api/session', requireParticipant, async (req, res) => {
    const s = sessionForParticipant(req.participantId);
    if (!s) return res.status(404).json({ error: 'no_session' });
    const p = get('SELECT label,track FROM participants WHERE id=?', req.participantId);
    if (s.state === 'REENTRY' && !s.checkin_day) {
      try { await openCheckin(s.id); } catch (e) { console.error('openCheckin:', e.message); }
    }
    res.json({ session: summary(s.id), messages: transcript(s.id), participant: p, agentName: config.agentName });
  });

  app.post('/api/message', requireParticipant, async (req, res) => {
    const s = sessionForParticipant(req.participantId);
    if (!s) return res.status(404).json({ error: 'no_session' });
    try {
      res.json(await handleUserMessage(s.id, req.body?.text));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('message error:', e);
      res.status(500).json({ error: 'agent_error', detail: config.devMode ? e.message : undefined });
    }
  });

  app.get('/report/:version', requireParticipant, (req, res) => {
    const s = sessionForParticipant(req.participantId);
    const html = s && renderStored(s.id, Number(req.params.version));
    if (!html) return res.status(404).send('No such report version.');
    res.type('html').send(html);
  });

  app.post('/api/me/delete', requireParticipant, (req, res) => {
    deleteParticipant(req.participantId);
    clearCookie(res, 'wid');
    res.json({ ok: true });
  });

  // ---------- staff ----------
  app.get('/staff/login', (req, res) => res.sendFile(pub('staff-login.html')));
  app.post('/api/staff/login', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL.test(email) || limited(`staff:${req.ip}`, 10)) return res.status(400).json({ ok: true });
    let devLink;
    if (config.staffEmails.includes(email)) {
      const token = createToken({ staffEmail: email, purpose: 'staff', ttlMs: 15 * MIN });
      const link = `${config.baseUrl}/staff/auth/${token}`;
      await sendMail({ to: email, kind: 'staff', subject: 'Cognitive Wedge staff sign-in', text: 'This link signs you in for 8 hours and works once.', link });
      if (config.devMode) devLink = link;
    }
    res.json({ ok: true, ...(devLink ? { devLink } : {}) }); // same answer for every address
  });
  app.get('/staff/auth/:token', (req, res) => {
    const t = redeemToken(req.params.token);
    if (!t || t.purpose !== 'staff' || !config.staffEmails.includes(t.staff_email)) return res.status(400).send('This link is not valid or has expired.');
    setCookie(res, 'wst', startAuthSession('staff', t.staff_email, STAFF_TTL), STAFF_TTL);
    res.redirect('/staff');
  });
  app.get('/staff', requireStaff, (req, res) => res.sendFile(pub('dashboard.html')));
  app.get('/api/staff/data', requireStaff, (req, res) => res.json(dashboardData()));
  app.get('/api/staff/participant/:sid', requireStaff, (req, res) => {
    const d = participantDetail(req.params.sid);
    if (!d) return res.status(404).json({ error: 'not_found' });
    const s = getSession(req.params.sid);
    run('INSERT INTO access_log (staff_email,participant_id,created_at) VALUES (?,?,?)', req.staffEmail, s.participant_id, now());
    res.json(d);
  });
  app.get('/staff/report/:sid/:version', requireStaff, (req, res) => {
    const html = renderStored(req.params.sid, Number(req.params.version));
    if (!html) return res.status(404).send('No such report.');
    const s = getSession(req.params.sid);
    run('INSERT INTO access_log (staff_email,participant_id,created_at) VALUES (?,?,?)', req.staffEmail, s.participant_id, now());
    res.type('html').send(html);
  });

  // ---------- dev helpers (DEV_MODE only) ----------
  if (config.devMode) {
    app.get('/dev/outbox', (req, res) => {
      const rows = outbox();
      res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Dev outbox</title><body style="font:14px system-ui;max-width:760px;margin:24px auto;padding:0 16px"><h1>Dev outbox</h1><p>Emails are not sent in dev mode. Click a link to act as that recipient.</p>${rows.map((r) => `<p><b>${r.kind}</b> to ${r.to_addr}<br>${r.link ? `<a href="${r.link}">${r.link}</a>` : ''}</p>`).join('') || '<p>Empty.</p>'}</body>`);
    });
    // Move the app clock forward so a tester does not wait days for a check-in.
    app.post('/dev/advance', async (req, res) => {
      const days = Number(req.body?.days || 0), minutes = Number(req.body?.minutes || 0);
      advance(days * DAY + minutes * MIN);
      await tick();
      res.json({ ok: true });
    });
  }

  return app;
}

export function main() {
  openDb();
  if (!config.apiKey && !config.mockLlm) {
    console.warn('\n!! ANTHROPIC_API_KEY is not set. Participant messages will fail. Set it, or set MOCK_LLM=1 for the scripted stand-in agent.\n');
  }
  if (config.mockLlm) console.warn('MOCK_LLM is on: a scripted stand-in is answering, not Claude.');
  if (!config.staffEmails.length) console.warn('STAFF_EMAILS is empty: nobody can open the staff dashboard.');
  startScheduler();
  const app = createApp();
  app.listen(config.port, () => console.log(`Cognitive Wedge on ${config.baseUrl}${config.devMode ? ' (dev mode)' : ''}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
