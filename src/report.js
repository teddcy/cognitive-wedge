// One-page participant report (spec: One-page participant report).
// Verbatim or fixed: every participant field appears as typed, every label is fixed text.
// No generated summary, interpretation, praise or advice. Fields are only trimmed to fit one sheet.
import { get, all, run } from './db.js';
import { latestRecords, textOf } from './records.js';
import { now, DAY } from './clock.js';
import { STATE_LABEL } from './gates.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Cut at a sentence boundary under the cap, end with an ellipsis. Returns { text, truncated }.
export function trimField(value, cap) {
  const s = textOf(value).trim();
  if (s.length <= cap) return { text: s, truncated: false };
  const head = s.slice(0, cap);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('.\n'));
  let cut = sentence > cap * 0.4 ? head.slice(0, sentence + 1) : head.slice(0, head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : cap);
  cut = cut.trimEnd();
  return { text: `${cut}…`, truncated: true, source: s };
}

// A string check: trimmed text (without the ellipsis) must be a prefix of its source field.
export function assertTrimmed(trimmed, source) {
  if (!trimmed.endsWith('…')) return trimmed === source;
  return source.startsWith(trimmed.slice(0, -1));
}

const CAPS = {
  task: 200, right: 220, wrong: 220, felt: 220, gap: 220, evidence: 130, unwritten: 220, belief: 160,
  source: 120, uncomfortable: 200, build: 220, why: 200, seen: 80, slot: 70, handoff: 90, judg: 90,
  holds: 240, delegates: 240, stops: 200, telltale: 240, next: 200, commit: 160, outcome: 140,
};

// Collects the fields the report shows. Everything here is the participant's own entry.
export function snapshotFor(sessionId) {
  const r = latestRecords(sessionId);
  const s = get('SELECT * FROM sessions WHERE id=?', sessionId);
  const p = get('SELECT * FROM participants WHERE id=?', s.participant_id);
  const plan = get("SELECT created_at FROM records WHERE session_id=? AND name='reentry_plan' ORDER BY version DESC LIMIT 1", sessionId);
  const checks = all('SELECT * FROM checkins WHERE session_id=? ORDER BY day', sessionId);
  const outcomes = {};
  for (const row of all("SELECT data FROM records WHERE session_id=? AND name='checkin' ORDER BY version", sessionId)) {
    const d = JSON.parse(row.data);
    outcomes[Number(d.day)] = d;
  }
  return {
    participant: p.label, track: p.track,
    task: r.declared_task, witness: r.witness_card, gap: textOf(r.gap_statement),
    decomposition: r.decomposition, ledger: r.assumption_ledger?.entries || [], belief0: r.belief_ledger_0,
    uncomfortable: textOf(r.most_uncomfortable_entry),
    build: r.build_brief, artifact: r.artifact,
    model: r.operating_model?.week || [], statement: r.wedge_statement,
    plan: r.reentry_plan?.checkpoints || [], planDate: plan?.created_at || null,
    checks: checks.map((c) => ({ day: c.day, scheduled_for: c.scheduled_for, completed_at: c.completed_at })),
    outcomes,
  };
}

const outcomeText = (day, o) => {
  if (!o) return 'Not yet recorded';
  const parts = [o.commitment_done === true ? 'Commitment done' : o.commitment_done === false ? 'Commitment not done' : null,
    o.telltale_observed === true ? 'Tell-tale seen' : o.telltale_observed === false ? 'Tell-tale not seen' : null,
    o.acted_on ? `Acted on: ${o.acted_on}` : null,
    day === 30 && o.build_shipped != null ? (o.build_shipped ? 'Second build shipped' : 'Second build not shipped') : null,
    day === 30 && o.model_in_use ? `Operating model ${o.model_in_use}` : null].filter(Boolean);
  return parts.join('. ') || 'Recorded';
};

// Builds render-ready blocks, trimming long fields. Returns { blocks, truncated[] }.
export function buildBlocks(snap) {
  const truncated = [];
  const t = (label, v, cap) => {
    const x = trimField(v, cap);
    if (x.truncated) { truncated.push(label); if (!assertTrimmed(x.text, x.source)) throw new Error(`trim check failed for ${label}`); }
    return x.text;
  };
  const d = snap.decomposition || { layers: [] };
  const inheritedOrDefensive = snap.ledger.filter((e) => e.tag === 'inherited' || e.tag === 'defensive');
  return {
    task: { text: t('task', snap.task?.text, CAPS.task), type: snap.task?.task_type || '' },
    witness: { right: t('right', snap.witness?.right, CAPS.right), wrong: t('wrong', snap.witness?.wrong, CAPS.wrong), felt: t('felt', snap.witness?.felt, CAPS.felt) },
    gap: t('gap', snap.gap, CAPS.gap),
    layers: (d.layers || []).map((l) => ({ layer: l.layer, verdict: String(l.verdict || '').replace('_', ' '), evidence: l.evidence_basis === 'no_line_found' ? 'No line pointed to' : t(`evidence:${l.layer}`, l.evidence, CAPS.evidence) })),
    attached: d.most_attached_layer || '',
    unwritten: t('unwritten', d.unwritten_knowledge, CAPS.unwritten),
    assumed: inheritedOrDefensive.map((e, i) => ({
      belief: t(`belief:${i}`, e.belief, CAPS.belief), tag: String(e.tag).replace('_', ' '), category: e.category,
      source: snap.belief0 && textOf(snap.belief0.belief).trim() === textOf(e.belief).trim()
        ? t('source', `${snap.belief0.source_kind || ''}${snap.belief0.source_text ? `: ${snap.belief0.source_text}` : ''}, ${snap.belief0.date_acquired || ''}`, CAPS.source) : '',
    })),
    uncomfortable: t('uncomfortable', snap.uncomfortable, CAPS.uncomfortable),
    build: { what: t('build', snap.build?.what, CAPS.build), why: t('why', snap.build?.why_out_of_reach, CAPS.why), seen: t('seen', snap.build?.seen_by, CAPS.seen), shown: snap.artifact?.shown_at || '' },
    model: snap.model.map((m, i) => ({ slot: t(`slot:${i}`, m.slot, CAPS.slot), layer: m.layer, mode: m.mode, handoff: t(`handoff:${i}`, m.handoff, CAPS.handoff), judg: t(`judg:${i}`, m.judgment_reenters, CAPS.judg) })),
    statement: {
      holds: t('holds', snap.statement?.holds, CAPS.holds), delegates: t('delegates', snap.statement?.delegates, CAPS.delegates),
      stops: t('stops', snap.statement?.stops, CAPS.stops), telltale: t('telltale', snap.statement?.telltale, CAPS.telltale), next: t('next', snap.statement?.next_build, CAPS.next),
    },
    path: [3, 10, 30].map((day) => {
      const cp = snap.plan.find((c) => Number(c.day) === day);
      const sched = snap.checks.find((c) => c.day === day);
      return {
        day, date: sched ? new Date(sched.scheduled_for).toISOString().slice(0, 10) : '',
        commitment: t(`commit:${day}`, cp?.commitment, CAPS.commit), outcome: t(`outcome:${day}`, outcomeText(day, snap.outcomes[day]), CAPS.outcome),
      };
    }),
    truncated,
  };
}

const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f4f3ef;color:#161616;font:13px/1.45 'Source Sans 3',system-ui,-apple-system,'Segoe UI',sans-serif}
.page{max-width:8.5in;margin:16px auto;background:#fff;padding:.5in .55in;box-shadow:0 1px 4px rgba(0,0,0,.12)}
h1{font-size:19px;margin:0 0 2px}
.meta{color:#52514e;font-size:12px;margin-bottom:10px}
h2{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#52514e;margin:11px 0 4px;border-top:1px solid #e1e0d9;padding-top:7px}
p{margin:2px 0}
.q{color:#161616}
.lab{color:#52514e;font-size:11.5px}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{text-align:left;vertical-align:top;padding:2px 6px 2px 0;border-bottom:1px solid #eeede8}
th{font-weight:600;color:#52514e;font-size:11px}
.tell{border-left:3px solid #2a78d6;padding:3px 0 3px 9px;margin:5px 0;font-weight:600}
.foot{margin-top:10px;color:#898781;font-size:11px}
.bar{max-width:8.5in;margin:12px auto 0;display:flex;gap:10px;justify-content:flex-end;padding:0 4px}
button,a.btn{font:inherit;font-size:13px;padding:6px 12px;border:1px solid #c3c2b7;background:#fff;border-radius:6px;cursor:pointer;color:#161616;text-decoration:none}
@media print{body{background:#fff}.page{box-shadow:none;margin:0;padding:0;max-width:none}.bar{display:none}@page{size:letter;margin:14mm}}
`;

const row = (label, text) => (text ? `<p><span class="lab">${esc(label)}</span> <span class="q">${esc(text)}</span></p>` : '');

export function renderHtml(snap, meta) {
  const b = buildBlocks(snap);
  const date = new Date(meta.generated_at).toISOString().slice(0, 10);
  const note = b.truncated.length ? '<p class="foot">Some entries are shortened to fit one page. The full text is in your session.</p>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cognitive Wedge report ${esc(snap.participant)} v${meta.version}</title><style>${CSS}</style></head><body>
<div class="bar"><a class="btn" href="/chat">Back to session</a><button type="button" onclick="window.print()">Print or save as PDF</button></div>
<main class="page">
<h1>Cognitive Wedge report</h1>
<div class="meta">${esc(snap.participant)} · ${esc(snap.track)} · ${esc(date)} · version ${meta.version} (${esc(meta.checkpoint.replace('_', ' '))})</div>

<h2>What I tested</h2>
${row('Task', b.task.text)}${row('Type', b.task.type)}
${row('Right', b.witness.right)}${row('Wrong', b.witness.wrong)}${row('Felt', b.witness.felt)}${row('What I was less sure of', b.gap)}

<h2>What was in it</h2>
<table><tr><th>Layer</th><th>My verdict</th><th>The line I pointed to</th></tr>${b.layers.map((l) => `<tr><td>${esc(l.layer)}</td><td>${esc(l.verdict)}</td><td>${esc(l.evidence)}</td></tr>`).join('')}</table>
${row('Most attached to', b.attached)}${row('What the task needed that was not written down', b.unwritten)}

<h2>What I assumed</h2>
${b.assumed.length ? b.assumed.map((a) => `<p><span class="q">${esc(a.belief)}</span> <span class="lab">(${esc(a.tag)}, ${esc(a.category)}${a.source ? `; ${esc(a.source)}` : ''})</span></p>`).join('') : '<p class="lab">No assumption was tagged inherited or defensive.</p>'}
${row('Most uncomfortable to lose', b.uncomfortable)}

<h2>What I built</h2>
${row('What', b.build.what)}${row('Why it was out of reach', b.build.why)}${row('Who sees it', b.build.seen)}${row('Date shown', b.build.shown)}

<h2>How I work now</h2>
${b.model.length ? `<table><tr><th>Block</th><th>Layer</th><th>Hold or delegate</th><th>Handoff</th><th>Where judgment re-enters</th></tr>${b.model.map((m) => `<tr><td>${esc(m.slot)}</td><td>${esc(m.layer)}</td><td>${esc(m.mode)}</td><td>${esc(m.handoff)}</td><td>${esc(m.judg)}</td></tr>`).join('')}</table>` : '<p class="lab">Not recorded.</p>'}

<h2>My wedge statement</h2>
${row('I hold', b.statement.holds)}${row('I delegate', b.statement.delegates)}${row('I stop', b.statement.stops)}
<div class="tell"><span class="lab">My tell-tale</span><br>${esc(b.statement.telltale)}</div>
${row('My next build', b.statement.next)}

<h2>My path</h2>
<table><tr><th>Day</th><th>Date</th><th>My commitment</th><th>What happened</th></tr>${b.path.map((p) => `<tr><td>${p.day}</td><td>${esc(p.date)}</td><td>${esc(p.commitment)}</td><td>${esc(p.outcome)}</td></tr>`).join('')}</table>
${note}
</main></body></html>`;
}

// Generates and stores the next version. Old versions are kept.
export function generateReport(sessionId, checkpoint) {
  const snap = snapshotFor(sessionId);
  const { truncated } = buildBlocks(snap);
  const v = (get('SELECT MAX(version) v FROM reports WHERE session_id=?', sessionId)?.v || 0) + 1;
  run(
    'INSERT INTO reports (session_id,version,checkpoint,generated_at,snapshot,truncated) VALUES (?,?,?,?,?,?)',
    sessionId, v, checkpoint, now(), JSON.stringify(snap), JSON.stringify(truncated),
  );
  return v;
}

export function renderStored(sessionId, version) {
  const row = get('SELECT * FROM reports WHERE session_id=? AND version=?', sessionId, version);
  if (!row) return null;
  return renderHtml(JSON.parse(row.snapshot), { version: row.version, checkpoint: row.checkpoint, generated_at: row.generated_at });
}

export const reportVersions = (sessionId) =>
  all('SELECT version,checkpoint,generated_at FROM reports WHERE session_id=? ORDER BY version', sessionId);

export { STATE_LABEL, DAY };
