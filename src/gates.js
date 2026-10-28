import fs from 'node:fs';
import { checkTelltale } from './telltale.js';
import { textOf, wordCount } from './records.js';

export const STATES = ['ORIENTATION', 'ONBOARDING', 'RUPTURE', 'DECONSTRUCTION', 'RECONSTRUCTION', 'REENTRY'];
export const STATE_LABEL = {
  ORIENTATION: 'Orientation', ONBOARDING: 'Onboarding', RUPTURE: 'Rupture',
  DECONSTRUCTION: 'Deconstruction', RECONSTRUCTION: 'Reconstruction', REENTRY: 'Re-entry',
};
// Four-step progress bar shown to participants.
export const STEP_OF = { ORIENTATION: 0, ONBOARDING: 1, RUPTURE: 1, DECONSTRUCTION: 2, RECONSTRUCTION: 3, REENTRY: 4 };
export const STEP_LABELS = ['Onboarding and Rupture', 'Deconstruction', 'Reconstruction', 'Re-entry'];

export const MODULE_OF = {
  ORIENTATION: 'm0', ONBOARDING: 'm1', RUPTURE: 'm1', DECONSTRUCTION: 'm2', RECONSTRUCTION: 'm3', REENTRY: 'm4',
};
export const nextState = (s) => STATES[STATES.indexOf(s) + 1] || null;

// Records each state is allowed to complete (used to count a gate "retry").
export const WRITES = {
  ORIENTATION: ['orientation'],
  ONBOARDING: ['role_inventory', 'origin_paragraph', 'declared_task'],
  RUPTURE: ['witness_card', 'belief_ledger_0', 'gap_statement'],
  DECONSTRUCTION: ['decomposition', 'process_archaeology', 'assumption_ledger', 'most_uncomfortable_entry', 'read_back'],
  RECONSTRUCTION: ['build_brief', 'artifact', 'operating_model', 'wedge_statement', 'reentry_plan'],
  REENTRY: ['checkin'],
};

let libCache;
export function taskLibrary() {
  if (!libCache) libCache = JSON.parse(fs.readFileSync(new URL('../data/task_library.json', import.meta.url), 'utf8')).types;
  return libCache;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export const inLibrary = (t) => !!t && taskLibrary().some((x) => norm(x) === norm(t));

const LAYERS = ['intent', 'context', 'judgment', 'relationship', 'execution'];
const VERDICTS = ['touched', 'faked', 'never_reached'];
const BASIS = ['pointed_to_line', 'no_line_found'];
const CATS = ['role', 'process', 'contribution'];
const TAGS = ['still_true', 'inherited', 'defensive'];
const STATUS = ['present', 'gone', 'unknown'];
const VAGUE_READER = /^(someone|somebody|a colleague|colleagues|my team|the team|people|a friend|my boss|someone on my team|anyone)\b/i;

const filled = (v) => textOf(v).trim().length > 0;

// Each gate returns { ok, missing[] } from the latest records.
export const GATES = {
  ORIENTATION(r) {
    const o = r.orientation || {};
    const missing = [];
    if (!filled(o.restated_objective)) missing.push('restated_objective');
    if (o.terms_accepted !== true) missing.push('terms_accepted');
    if (o.budget_accepted !== true) missing.push('budget_accepted');
    return { ok: !missing.length, missing };
  },
  ONBOARDING(r, fast) {
    const need = fast ? 2 : 3;
    const missing = [];
    const rows = r.role_inventory?.rows || [];
    for (const col of ['do', 'only_i', 'never_delegate']) {
      const n = rows.filter((x) => x.column === col && filled(x.text)).length;
      if (n < need) missing.push(`role_inventory column "${col}" needs ${need} items (has ${n})`);
    }
    const t = r.declared_task;
    if (!t || !filled(t.text)) missing.push('declared_task');
    else if (!inLibrary(t.task_type)) missing.push('declared_task.task_type is not in the accepted library');
    const words = wordCount(textOf(r.origin_paragraph));
    const minWords = fast ? 40 : 60;
    if (words < minWords) missing.push(`origin_paragraph needs ${minWords} words (has ${words})`);
    return { ok: !missing.length, missing };
  },
  RUPTURE(r) {
    const missing = [];
    if (!filled(r.witness_card?.felt)) missing.push('witness_card.felt');
    const b = r.belief_ledger_0 || {};
    if (!filled(b.belief)) missing.push('belief_ledger_0.belief');
    if (!filled(b.source_kind) && !filled(b.source_text)) missing.push('belief_ledger_0 source');
    if (!filled(b.date_acquired)) missing.push('belief_ledger_0.date_acquired');
    if (!filled(textOf(r.gap_statement))) missing.push('gap_statement');
    return { ok: !missing.length, missing };
  },
  DECONSTRUCTION(r, fast) {
    const missing = [];
    const layers = r.decomposition?.layers || [];
    for (const l of LAYERS) {
      const x = layers.find((y) => y.layer === l);
      if (!x) { missing.push(`decomposition layer "${l}"`); continue; }
      if (!VERDICTS.includes(x.verdict)) missing.push(`verdict for ${l}`);
      if (!BASIS.includes(x.evidence_basis)) missing.push(`evidence_basis for ${l}`);
      else if (x.evidence_basis === 'pointed_to_line' && !filled(x.evidence)) missing.push(`evidence for ${l}`);
    }
    const steps = (r.process_archaeology?.steps || []).filter((s) => filled(s.step) && STATUS.includes(s.status));
    const needSteps = fast ? 2 : 3;
    if (steps.length < needSteps) missing.push(`process_archaeology needs ${needSteps} steps with a constraint status (has ${steps.length})`);
    const entries = r.assumption_ledger?.entries || [];
    const good = entries.filter((e) => filled(e.belief) && CATS.includes(e.category) && TAGS.includes(e.tag));
    if (good.length < 3 || entries.length !== good.length) {
      if (!(fast && good.length >= 2 && entries.length === good.length)) {
        missing.push(`assumption_ledger needs ${fast ? 2 : 3} entries, each categorised and tagged by the participant (has ${good.length})`);
      }
    }
    if (!r.read_back) missing.push('read_back (closing step)');
    return { ok: !missing.length, missing };
  },
  RECONSTRUCTION(r) {
    const missing = [];
    const seen = textOf(r.build_brief?.seen_by).trim();
    if (!seen || VAGUE_READER.test(seen)) missing.push('build_brief.seen_by must be a named person');
    const a = r.artifact;
    if (!a || !(filled(a.link) || filled(a.description))) missing.push('artifact attached or linked');
    const tt = textOf(r.wedge_statement?.telltale);
    const chk = checkTelltale(tt);
    if (!chk.ok) missing.push(`wedge_statement.telltale fails the specificity check (${chk.reason})`);
    const cps = r.reentry_plan?.checkpoints || [];
    for (const d of [3, 10, 30]) {
      const c = cps.find((x) => Number(x.day) === d);
      if (!c || !filled(c.commitment)) missing.push(`reentry_plan commitment for day ${d}`);
    }
    return { ok: !missing.length, missing };
  },
  REENTRY() {
    return { ok: false, missing: [] };
  },
};

export const hasVagueReader = (s) => VAGUE_READER.test(String(s || '').trim());
export { LAYERS, VERDICTS, BASIS, CATS, TAGS, STATUS };

// Per-record validation used to count a gate "retry": the agent emitted a record that fails its own checks.
export function recordProblems(name, data, fast) {
  const p = [];
  const need = fast ? 2 : 3;
  if (name === 'role_inventory') {
    const rows = data?.rows || [];
    for (const col of ['do', 'only_i', 'never_delegate']) {
      if (rows.filter((x) => x.column === col && filled(x.text)).length < need) p.push(`role_inventory ${col}`);
    }
  } else if (name === 'origin_paragraph') {
    if (wordCount(textOf(data)) < (fast ? 40 : 60)) p.push('origin_paragraph too short');
  } else if (name === 'declared_task') {
    if (!inLibrary(data?.task_type)) p.push('declared_task not in library');
  } else if (name === 'wedge_statement') {
    const c = checkTelltale(textOf(data?.telltale));
    if (!c.ok) p.push(`telltale: ${c.reason}`);
  } else if (name === 'build_brief') {
    const seen = textOf(data?.seen_by).trim();
    if (!seen || VAGUE_READER.test(seen)) p.push('seen_by not a named person');
  } else if (name === 'decomposition') {
    const ls = data?.layers || [];
    if (LAYERS.some((l) => !ls.find((x) => x.layer === l && VERDICTS.includes(x.verdict) && BASIS.includes(x.evidence_basis)))) p.push('decomposition incomplete');
  } else if (name === 'process_archaeology') {
    if ((data?.steps || []).filter((s) => filled(s.step) && STATUS.includes(s.status)).length < need) p.push('process_archaeology too few steps');
  } else if (name === 'assumption_ledger') {
    const es = data?.entries || [];
    if (es.length < need || es.some((e) => !CATS.includes(e.category) || !TAGS.includes(e.tag))) p.push('assumption_ledger incomplete');
  }
  return p;
}
