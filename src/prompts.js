import fs from 'node:fs';
import { config, DATA_NOTICE, TOTAL_MINUTES, MINUTES_TO_BUILD } from './config.js';
import { taskLibrary } from './gates.js';

const dir = new URL('../prompts/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, dir), 'utf8').trim();

const FILES = {
  preamble: '00-preamble.md',
  m0: '10-orientation.md',
  m1: '20-onboarding-rupture.md',
  m2: '30-deconstruction.md',
  m3: '40-reconstruction.md',
  m4: '50-reentry.md',
};
const cache = {};
const file = (k) => (cache[k] ||= read(FILES[k]));

export const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

// Added at implementation (not in the spec text): tells the agent exactly how to emit each record,
// so the gates can read them. Names and fields follow the spec's data model.
export const RECORD_FORMAT = `RECORD FORMAT (system)
Emit records in a code fence labelled record. One JSON object per fence; each top-level key is a record name. Use exactly these names and shapes. Emit a record only when every field in it was supplied by the person, and emit each record once, in the turn that completes it. Do not mention the fence.
orientation: {"restated_objective":"","restate_attempts":0,"terms_accepted":true,"budget_accepted":true,"start_deferred":null}
role_inventory: {"rows":[{"column":"do|only_i|never_delegate","text":""}]}
origin_paragraph: "<their paragraph, verbatim>"
declared_task: {"text":"","task_type":"<exactly one entry from ACCEPTED TASK TYPES>","inputs":[{"label":"","content":""}]}
witness_card: {"right":"","wrong":"","felt":"","felt_reprompts":0}
belief_ledger_0: {"belief":"","source_kind":"boss|credential|first_job|fear|other","source_text":"","date_acquired":""}
gap_statement: "<verbatim>"
decomposition: {"layers":[{"layer":"intent|context|judgment|relationship|execution","verdict":"touched|faked|never_reached","evidence":"","evidence_basis":"pointed_to_line|no_line_found"}],"most_attached_layer":"","unwritten_knowledge":""}
process_archaeology: {"workflow":"","steps":[{"step":"","originating_constraint":"","status":"present|gone|unknown"}]}
assumption_ledger: {"entries":[{"belief":"","category":"role|process|contribution","tag":"still_true|inherited|defensive"}]}   (include belief_ledger_0 as an entry)
most_uncomfortable_entry: "<verbatim>"
read_back: {"inherited_sentence":"","defensive_sentence":"","response":"","done":true}
build_brief: {"proposal":"","accepted":true,"what":"","why_out_of_reach":"","seen_by":"","reproposals":0}
artifact: {"link":"","description":"","shown_at":"YYYY-MM-DD"}   (shown_at is the date they will show it)
operating_model: {"week":[{"slot":"","layer":"","mode":"hold|delegate","handoff":"","judgment_reenters":""}]}
wedge_statement: {"holds":"","delegates":"","stops":"","telltale":"","next_build":""}
reentry_plan: {"checkpoints":[{"day":3,"commitment":"","linked_row":""},{"day":10,"commitment":""},{"day":30,"commitment":""}]}
checkin: {"day":3,"commitment_done":true,"telltale_observed":false,"acted_on":"","build_shipped":null,"seen_by":"","model_in_use":"held|drifted|abandoned|null","statement":"unchanged|revised|abandoned","new_telltale":"","platform_in_use":null}
distress: {"note":"stopped"}   (emit only if you stopped the script for real distress)
Timing of emission: in Deconstruction, emit assumption_ledger, most_uncomfortable_entry and read_back together, in the turn that closes the module after their read-back answer. In Reconstruction, emit reentry_plan last. In ONBOARDING, never reveal the accepted task types as a menu; use them only to judge fit.`;

export function moduleKey(state, day) {
  const base = { ORIENTATION: 'm0', ONBOARDING: 'm1', RUPTURE: 'm1', DECONSTRUCTION: 'm2', RECONSTRUCTION: 'm3', REENTRY: 'm4' }[state];
  return base === 'm4' ? `m4-d${day}` : base;
}

export function buildSystem({ state, day, recs, clock, gateMissing = [], recordErrors = [], plan }) {
  const vars = {
    agent_name: config.agentName,
    minutes_left: clock.minutesLeft?.toFixed?.(1) ?? '',
    state_budget_minutes: clock.budget ?? '',
    gate_mode: clock.gateMode,
    total_minutes: TOTAL_MINUTES,
    minutes_to_build: MINUTES_TO_BUILD,
    data_notice: DATA_NOTICE,
    task_library: taskLibrary().map((t) => `- ${t}`).join('\n'),
    day: day ?? '',
    date: plan?.date ?? '',
    commitment: plan?.commitment ?? '',
    telltale: plan?.telltale ?? '',
    next_build: plan?.next_build ?? '',
  };
  const modKey = moduleKey(state, day).split('-')[0];
  let mod = fill(file(modKey), vars);

  if (modKey === 'm4') {
    // Keep only the section for this checkpoint.
    const marks = ['DAY 3', 'DAY 10', 'DAY 30'];
    const mine = `DAY ${day}`;
    const start = mod.indexOf(`\n${mine}\n`);
    if (start > -1) {
      const others = marks.filter((m) => m !== mine).map((m) => mod.indexOf(`\n${m}\n`)).filter((i) => i > start);
      const abandon = mod.indexOf('\nIF THEY HAVE ABANDONED THE STATEMENT');
      const end = Math.min(...[...others, abandon].filter((i) => i > start));
      mod = mod.slice(0, mod.indexOf('\nDAY 3\n')) + mod.slice(start, end) + mod.slice(abandon);
    }
    if (config.platformCheck && Number(day) === 30) {
      mod += `\n\nADDED QUESTION (day 30, after the operating-model question): "Are the tasks you handed over now being done on ${config.platformName}?" Record platform_in_use true or false. Ask nothing else about it.`;
    }
  }

  const stateLines = [
    'SYSTEM STATE',
    `state: ${state}${day ? ` (day ${day})` : ''}`,
    clock.budget ? `minutes_left: ${clock.minutesLeft.toFixed(1)} of ${clock.budget}` : null,
    `gate_mode: ${clock.gateMode}`,
    clock.buildMinutes != null ? `build_minutes_elapsed: ${clock.buildMinutes.toFixed(1)}` : null,
    clock.nudgeDue ? 'NUDGE_DUE: give the minute-10 nudge now, once.' : null,
    gateMissing.length ? `GATE STATUS (what stored records still lack for this state; do not mention it to the person, just work toward it):\n${gateMissing.map((m) => `- ${m}`).join('\n')}` : null,
    recordErrors.length ? `RECORD ERRORS in your last turn: ${recordErrors.join('; ')}. Re-emit the record correctly once the field is complete.` : null,
  ].filter(Boolean).join('\n');

  return [
    fill(file('preamble'), vars),
    mod,
    `RECORDS\n${JSON.stringify(recs, null, 2)}`,
    stateLines,
    RECORD_FORMAT,
  ].join('\n\n');
}
