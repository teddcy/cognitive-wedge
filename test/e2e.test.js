import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, all, get, clock, engine, scheduler, auth, walkthrough, say, newSession } from './helpers.js';

openDb(':memory:');
const W = walkthrough();

async function runToReentry(email) {
  const { p, sid } = newSession(email);
  await say(sid, W.orientation);
  assert.equal(engine.getSession(sid).state, 'ONBOARDING');
  await say(sid, W.onboarding.slice(0, 3));
  clock.advance(5 * clock.MIN); // eat most of the 7-minute budget so fast mode switches on
  await say(sid, W.onboarding.slice(3));
  assert.equal(engine.getSession(sid).state, 'RUPTURE');
  await say(sid, W.rupture);
  assert.equal(engine.getSession(sid).state, 'DECONSTRUCTION');
  await say(sid, W.deconstruction);
  assert.equal(engine.getSession(sid).state, 'RECONSTRUCTION');
  await say(sid, W.reconstruction);
  return { p, sid };
}

test('walks all six states with gates, timing, report and score', async () => {
  const { p, sid } = await runToReentry('walk@example.com');
  const s = engine.getSession(sid);
  assert.equal(s.state, 'REENTRY');

  const timing = all('SELECT * FROM state_timing WHERE session_id=? ORDER BY id', sid);
  assert.deepEqual(timing.map((t) => t.state), ['ORIENTATION', 'ONBOARDING', 'RUPTURE', 'DECONSTRUCTION', 'RECONSTRUCTION']);
  assert.ok(timing.every((t) => t.exit_reason === 'gate_passed'));
  assert.equal(timing[1].gate_mode, 'fast', 'onboarding should have switched to fast mode');

  assert.ok(get("SELECT 1 x FROM records WHERE session_id=? AND name='performer_output'", sid), 'performer output stored');
  assert.equal(all('SELECT * FROM checkins WHERE session_id=?', sid).length, 3);
  assert.equal(get('SELECT COUNT(*) c FROM reports WHERE session_id=?', sid).c, 1);

  const sc = get("SELECT * FROM scores WHERE session_id=? AND checkpoint='reconstruction'", sid);
  assert.ok(sc && sc.total > 0 && sc.total <= 100);

  const mail = all("SELECT kind FROM emails WHERE session_id=?", sid).map((e) => e.kind);
  assert.ok(mail.includes('report'));
  return { p, sid };
});

test('check-ins arrive by email on day 3, 10 and 30 and refresh the report', async () => {
  const { p, sid } = await runToReentry('checkin@example.com');
  for (const [day, advanceBy] of [[3, 3], [10, 7], [30, 20]]) {
    clock.advance(advanceBy * clock.DAY);
    await scheduler.tick();
    const mail = get('SELECT * FROM emails WHERE session_id=? AND kind=?', sid, `checkin_${day}`);
    assert.ok(mail, `day ${day} email sent`);
    const token = mail.link.split('/s/')[1];
    const t = auth.redeemToken(token);
    assert.equal(t.day, day);
    await engine.openCheckin(sid, day);
    await say(sid, ['yes it did', 'yes I saw it']);
    assert.ok(get('SELECT completed_at FROM checkins WHERE session_id=? AND day=?', sid, day).completed_at);
  }
  assert.equal(get('SELECT COUNT(*) c FROM reports WHERE session_id=?', sid).c, 4);
  assert.equal(engine.getSession(sid).closed, 1);
});

test('resume emails: one at 30 minutes idle, one after 24 hours, never a third', async () => {
  const { sid } = newSession('idle@example.com');
  await say(sid, [W.orientation[0]]);
  clock.advance(31 * clock.MIN);
  await scheduler.tick();
  assert.equal(all("SELECT * FROM emails WHERE session_id=? AND kind='resume'", sid).length, 1);
  clock.advance(10 * clock.HOUR);
  await scheduler.tick();
  assert.equal(all("SELECT * FROM emails WHERE session_id=? AND kind='resume'", sid).length, 1);
  clock.advance(15 * clock.HOUR);
  await scheduler.tick();
  assert.equal(all("SELECT * FROM emails WHERE session_id=? AND kind='resume'", sid).length, 2);
  clock.advance(5 * clock.DAY);
  await scheduler.tick();
  assert.equal(all("SELECT * FROM emails WHERE session_id=? AND kind='resume'", sid).length, 2);
  // Coming back after an idle gap is recorded, and the idle time does not eat the state budget.
  await say(sid, [W.orientation[1]]);
  const s = engine.getSession(sid);
  assert.equal(s.idle_seen, 1);
  assert.equal(s.resumed, 1);
});

test('classifier: a reassuring turn in Rupture is regenerated, then replaced by the fixed question', async () => {
  const { sid } = newSession('classify@example.com');
  await say(sid, W.orientation);
  await say(sid, W.onboarding);
  const r = await engine.handleUserMessage(sid, 'ok [[reassure]]');
  assert.equal(r.messages[0].text, 'Say more about that, in your own words.');
  const log = all("SELECT verdict,fallback FROM classifier_log WHERE session_id=? AND module='m1'", sid);
  assert.ok(log.filter((l) => l.verdict === 'reassures').length >= 3);
  assert.ok(log.some((l) => l.fallback === 1));
});

test('a declined or deferred start does not advance', async () => {
  const { sid } = newSession('wait@example.com');
  await say(sid, ['It decides what I do.']);
  assert.equal(engine.getSession(sid).state, 'ORIENTATION');
});

test('deleting a participant removes their data', async () => {
  const { p, sid } = newSession('gone@example.com');
  await say(sid, W.orientation);
  const { deleteParticipant } = await import('../src/db.js');
  deleteParticipant(p.id);
  assert.equal(get('SELECT COUNT(*) c FROM messages WHERE session_id=?', sid).c, 0);
  assert.equal(get('SELECT COUNT(*) c FROM participants WHERE id=?', p.id).c, 0);
});
