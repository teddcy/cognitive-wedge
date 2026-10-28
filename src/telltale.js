// Tell-tale specificity check (spec: Constraints enforced in code).
// Rejected if it has no observable action plus an object, or matches the vagueness list.
const VAGUE = /\b(notice|noticing|noticed|feel|feeling|feels|felt|resist|resisting|resistance|mindful|mindfully|mindfulness)\b/i;

const ACTIONS = [
  'opened', 'open', 'typed', 'type', 'rewrote', 'rewrite', 'reached for', 'reach for', 'wrote', 'write', 'started', 'start',
  'drafted', 'draft', 'searched', 'search', 'copied', 'copy', 'pasted', 'paste', 'edited', 'edit', 'emailed', 'email',
  'called', 'call', 'scheduled', 'schedule', 'built', 'build', 'made', 'make', 'ran', 'run', 'clicked', 'click',
  'sat down', 'logged', 'log', 'booked', 'book', 'sent', 'send', 'fixed', 'fix', 'formatted', 'format', 'checked', 'check',
  'asked', 'ask', 'created', 'create', 'filled', 'fill', 'opened', 'did', 'do', 'redid', 'redo', 'retyped', 'tidied',
  'reviewed', 'review', 'proofread', 'rebuilt', 'rebuild', 'sorted', 'sort', 'tabbed', 'pulled', 'pull', 'added', 'add',
];

export function checkTelltale(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (VAGUE.test(t)) return { ok: false, reason: 'vague word' };
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 5) return { ok: false, reason: 'too short to be observable' };
  const lower = ` ${t.toLowerCase().replace(/[^a-z' ]/g, ' ')} `;
  const hasAction = ACTIONS.some((a) => lower.includes(` ${a} `));
  if (!hasAction) return { ok: false, reason: 'no observable action' };
  return { ok: true };
}
