import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { checkTelltale } from '../src/telltale.js';
import { trimField, assertTrimmed } from '../src/report.js';
import { GATES, inLibrary } from '../src/gates.js';
import { outlookFor, bandOf } from '../src/score.js';
import { extractRecords } from '../src/records.js';

test('tell-tale: observable action passes, vagueness fails', () => {
  assert.equal(checkTelltale('I opened a blank document and started typing').ok, true);
  assert.equal(checkTelltale('I reached for my old template instead of briefing the agent').ok, true);
  for (const bad of ['I notice when I feel resistant', 'be more mindful of delegating', 'stay aware', 'I resist the urge to rewrite things yourself']) {
    assert.equal(checkTelltale(bad).ok, false, bad);
  }
  assert.equal(checkTelltale('delegating').ok, false);
});

test('report trimming cuts at a sentence boundary and the check confirms a substring', () => {
  const src = 'First sentence is here. Second sentence is also here and goes on for a while longer than the cap allows. Third.';
  const t = trimField(src, 60);
  assert.equal(t.truncated, true);
  assert.ok(t.text.endsWith('…'));
  assert.ok(assertTrimmed(t.text, src));
  assert.equal(trimField('short', 60).truncated, false);
  assert.equal(assertTrimmed('not from the source…', src), false);
});

test('gates: orientation, onboarding and reconstruction need what the spec says', () => {
  assert.equal(GATES.ORIENTATION({ orientation: { restated_objective: 'x', terms_accepted: true, budget_accepted: true } }).ok, true);
  assert.equal(GATES.ORIENTATION({ orientation: { restated_objective: 'x', terms_accepted: true } }).ok, false);
  const rows = (n) => ['do', 'only_i', 'never_delegate'].flatMap((c) => Array.from({ length: n }, (_, i) => ({ column: c, text: `t${i}` })));
  const words = (n) => Array.from({ length: n }, () => 'word').join(' ');
  const base = { declared_task: { text: 'x', task_type: 'Client proposal' } };
  assert.equal(GATES.ONBOARDING({ ...base, role_inventory: { rows: rows(3) }, origin_paragraph: words(60) }, false).ok, true);
  assert.equal(GATES.ONBOARDING({ ...base, role_inventory: { rows: rows(2) }, origin_paragraph: words(60) }, false).ok, false);
  assert.equal(GATES.ONBOARDING({ ...base, role_inventory: { rows: rows(2) }, origin_paragraph: words(40) }, true).ok, true);
  assert.equal(GATES.ONBOARDING({ declared_task: { text: 'x', task_type: 'Negotiation prep' }, role_inventory: { rows: rows(3) }, origin_paragraph: words(60) }).ok, false);
  assert.equal(inLibrary(' client PROPOSAL '), true);
  const rec = {
    build_brief: { seen_by: 'someone on my team' }, artifact: { link: 'x' },
    wedge_statement: { telltale: 'I opened a blank document and started typing' },
    reentry_plan: { checkpoints: [3, 10, 30].map((day) => ({ day, commitment: 'c' })) },
  };
  assert.equal(GATES.RECONSTRUCTION(rec).ok, false, 'a vague reader is sent back');
  rec.build_brief.seen_by = 'Priya Nair';
  assert.equal(GATES.RECONSTRUCTION(rec).ok, true);
});

test('score bands and outlook drops follow the spec', () => {
  assert.equal(bandOf(75), 'strong'); assert.equal(bandOf(74), 'watch'); assert.equal(bandOf(55), 'watch'); assert.equal(bandOf(54), 'risk');
  const o = outlookFor(80, { 3: { commitment_done: false }, 10: { telltale_observed: true, acted_on: '' } });
  assert.equal(o.band, 'risk'); assert.equal(o.from, 'strong'); assert.equal(o.why.length, 2);
  assert.equal(outlookFor(80, { 3: { commitment_done: true } }).moved, false);
});

test('record fences are pulled out of the visible text', () => {
  const r = extractRecords('Next: your role.\n```record\n{"orientation":{"restated_objective":"x"}}\n```');
  assert.equal(r.visible, 'Next: your role.');
  assert.equal(r.records.length, 1);
  const bad = extractRecords('Hi\n```record\n{oops}\n```');
  assert.equal(bad.errors.length, 1);
});
