import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDb, clock, engine, scheduler, walkthrough, say, newSession } from './helpers.js';
import { dashboardData, participantDetail } from '../src/staff-data.js';

openDb(':memory:');
const W = walkthrough();

async function make() {
  // A spread of participants: stopped early, mid-way, finished, and fully through re-entry.
  const a = newSession('a@example.com').sid; await say(a, W.orientation.slice(0, 1));
  const b = newSession('b@example.com', 'personal').sid; await say(b, W.orientation); await say(b, W.onboarding);
  const c = newSession('c@example.com').sid; await say(c, [...W.orientation, ...W.onboarding, ...W.rupture, ...W.deconstruction.slice(0, 10)]);
  const d = newSession('d@example.com', 'personal').sid;
  await say(d, [...W.orientation, ...W.onboarding, ...W.rupture, ...W.deconstruction, ...W.reconstruction]);
  const e = newSession('e@example.com').sid;
  await say(e, [...W.orientation, ...W.onboarding, ...W.rupture, ...W.deconstruction, ...W.reconstruction]);
  for (const day of [3, 10, 30]) {
    clock.advance(day * clock.DAY);
    await scheduler.tick();
    await engine.openCheckin(e, day);
    await say(e, ['yes it did', 'yes I saw it']);
  }
  return { a, b, c, d, e };
}

test('dashboard data has the shape the views read, and every view renders without gaps', async () => {
  const ids = await make();
  const data = dashboardData();
  assert.equal(data.participants.length, 5);
  const byId = Object.fromEntries(data.participants.map((p) => [p.sid, p]));
  assert.equal(byId[ids.a].r, 1);
  assert.equal(byId[ids.b].r, 3);
  assert.equal(byId[ids.c].r, 4);
  assert.equal(byId[ids.d].r, 6);
  assert.equal(byId[ids.e].r, 9);
  assert.ok(byId[ids.d].sc && byId[ids.d].sc.total > 0);
  assert.ok(byId[ids.e].d30);
  assert.ok(!JSON.stringify(data).includes('renewal proposal'), 'aggregate rows carry no free text');
  assert.ok(JSON.stringify(participantDetail(ids.d)).includes('renewal proposal'), 'the participant page does');

  const html = fs.readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  const js = html.split('<script>')[1].split('</script>')[0];
  const els = {}; const handlers = {}; const docH = {};
  const mk = () => ({ closest() { return null; }, innerHTML: '', hidden: false, value: '', style: {}, textContent: '', setAttribute() {}, getAttribute() { return ''; }, focus() {}, offsetWidth: 100, offsetHeight: 20 });
  globalThis.document = { querySelector: (s) => els[s] || (els[s] = mk()), querySelectorAll: () => [], addEventListener: (e, f) => { docH[e] = f; }, activeElement: null };
  globalThis.window = { addEventListener: (e, f) => { handlers[e] = f; } };
  globalThis.location = { hash: '', search: '' };
  globalThis.innerWidth = 1200; globalThis.innerHeight = 800;
  globalThis.fetch = async (url) => ({ ok: true, json: async () => (String(url).includes('/participant/') ? participantDetail(String(url).split('/').pop()) : data) });
  new Function(js)();
  await new Promise((r) => setTimeout(r, 20));
  assert.match(els['#chip'].textContent, /Live data/);
  for (const v of ['funnel', 'friction', 'results', 'reentry', 'readiness', 'participants']) {
    globalThis.location.hash = `#${v}`; handlers.hashchange();
    const out = els['#view'].innerHTML;
    assert.ok(out.length > 200, `${v} rendered`);
    const bad = out.match(/.{40}(NaN|undefined|Infinity|\[object).{40}/);
    assert.equal(bad, null, `${v}: ${bad && bad[0]}`);
  }
  for (const id of Object.values(ids)) {
    docH.click({ target: { id: '', closest: (s) => (s === 'tr.pr' ? { getAttribute: () => data.participants.find((p) => p.sid === id).id } : null) } });
    await new Promise((r) => setTimeout(r, 10));
    const out = els['#drawer'].innerHTML;
    assert.ok(out.length > 200);
    assert.equal(out.match(/.{40}(NaN|undefined|Infinity|\[object).{40}/), null, out.slice(0, 300));
  }
});
