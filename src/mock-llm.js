// A scripted stand-in for the agent. It lets the team click through the whole flow, and lets the tests
// exercise gates, timing, reports and scoring, with no API key. It is NOT the real agent: set
// ANTHROPIC_API_KEY and leave MOCK_LLM unset for real runs.
const fence = (o) => '```record\n' + JSON.stringify(o) + '\n```';
const clip = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const LAYERS = ['intent', 'context', 'judgment', 'relationship', 'execution'];
const VERD = ['touched', 'faked', 'never_reached', 'faked', 'touched'];

const REASSURE = /still needs your judgment|of course it isn't perfect|starting point|you bring something/i;
const ADVISE = /you should|i suggest|i'd recommend|this shows|what this means/i;
const STEER = /might you mean|sounds like (touched|faked)|wouldn't you say|don't you think/i;
export function mockClassify(text, allowed) {
  if (allowed.includes('reassures') && REASSURE.test(text)) return 'reassures';
  if (allowed.includes('advises') && ADVISE.test(text)) return 'advises';
  if (allowed.includes('steers') && STEER.test(text)) return 'steers';
  return 'clean';
}

function stateOf(system) {
  const m = /^state: (\w+)(?: \(day (\d+)\))?/m.exec(system);
  return { state: m?.[1], day: m?.[2] ? Number(m[2]) : null };
}

export async function mockComplete({ system, messages }) {
  const { state, day } = stateOf(system);
  const users = messages.filter((m) => m.role === 'user' && m.content !== '[session started]').map((m) => m.content);
  const n = users.length;
  const u = (i) => users[i - 1] || '';
  const lib = /ACCEPTED TASK TYPES\n- (.+)/.exec(system)?.[1] || 'Client proposal';
  if (/\[\[reassure\]\]/.test(users[n - 1] || '')) return 'Of course it isn\'t perfect; it still needs your judgment.'; // lets tests exercise the classifier

  if (state === 'ORIENTATION') {
    if (n <= 1) return 'About 30 minutes to the build, about 65 in all. Can you stay for that now?';
    return 'Next: your role.\n' + fence({ orientation: { restated_objective: clip(u(1), 300), restate_attempts: 0, terms_accepted: true, budget_accepted: true } });
  }

  if (state === 'ONBOARDING' || state === 'RUPTURE') {
    const s = [
      null,
      'What I do. Give me three.',
      'What I believe only I can do. Give me three.',
      'What I would never delegate. Give me three.',
      'Where did you learn that this is your job?',
      'From your second and third columns, pick the one task you are most confident is yours. State it in one sentence. Don\'t explain it.',
      'The brief, the audience, the raw material, the deadline. Send what a competent colleague would have.',
    ];
    if (n >= 1 && n <= 6) return s[n];
    const split = (t) => String(t).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 3);
    if (n === 7) {
      const rows = [['do', 2], ['only_i', 3], ['never_delegate', 4]].flatMap(([c, i]) => split(u(i)).map((text) => ({ column: c, text })));
      return 'Understood.\n' + fence({
        role_inventory: { rows },
        origin_paragraph: u(5),
        declared_task: { text: clip(u(6), 300), task_type: lib, inputs: [{ label: 'brief', content: clip(u(7), 600) }] },
      });
    }
    if (n === 8) return 'Dear client, here is the full renewal proposal. Section 1: scope. Section 2: pricing. Section 3: timeline. Section 4: terms.';
    if (n === 9) return 'Three lines. What did it get right. What did it get wrong. What did you feel watching it.';
    if (n === 10) return 'What did you believe five minutes ago that you are less sure of now?';
    if (n === 11) return `You wrote: “${clip(u(5), 160)}”\nWhere did this belief come from? A boss, a credential, a first job, a fear?`;
    if (n === 12) return 'When did you acquire it?';
    return 'Next, we take this task apart into what was actually in it. After that, you build something with me that you couldn\'t have made alone.\n' + fence({
      witness_card: { right: clip(u(10), 200), wrong: clip(u(10), 200), felt: clip(u(10), 200), felt_reprompts: 0 },
      belief_ledger_0: { belief: clip(u(5), 160), source_kind: 'boss', source_text: clip(u(12), 160), date_acquired: clip(u(13), 40) },
      gap_statement: clip(u(11), 300),
    });
  }

  if (state === 'DECONSTRUCTION') {
    const q = [
      'Why does this task exist, and what must be true when it is done?',
      'What do you know about the situation, the people, the history that isn\'t written down anywhere?',
      'Of several acceptable outputs, which is the right one here, and how do you know?',
      'Who trusts you to do this, and what does your doing it signal to them?',
      'Producing the artifact itself. What is that work, concretely?',
    ];
    const verdictQ = 'Looking at what I produced: touched, faked, or never reached? Which line of my output, if any, shows that?';
    if (n === 1) return 'Five layers, in order. Intent first. ' + q[0];
    if (n >= 2 && n <= 10) return n % 2 === 0 ? verdictQ : q[(n - 1) / 2];
    if (n === 11) return 'Across all five, what did I need to know that wasn\'t written down anywhere?';
    if (n === 12) return 'Verdicts: touched, faked, never reached, faked, touched. Which layer were you most attached to?';
    if (n === 13) return 'Pick one workflow you run every week. List the steps.';
    if (n === 14 || n === 15 || n === 16) return 'What constraint originally shaped this step, and is it still present, gone, or do you not know?';
    if (n === 17) return 'Add two more assumptions about your role, your process, or your contribution that this exercise has exposed.';
    if (n === 18) return 'For each, its category: role, process or contribution?';
    if (n === 19) return 'still_true: it holds today. inherited: you took it from someone or somewhere. defensive: you hold it because the alternative frightens you. Tag every entry.';
    if (n === 20) return 'Which of these would you be most uncomfortable to lose?';
    if (n === 21) return 'Type the entry you tagged inherited and the one you tagged defensive, as full sentences.';
    if (n === 22) return 'What do you hear in that?';
    return 'Next, you build.\n' + fence({
      decomposition: {
        layers: LAYERS.map((layer, i) => ({
          layer, verdict: VERD[i], evidence: i === 2 ? '' : clip(u(3 + i * 2), 160),
          evidence_basis: i === 2 ? 'no_line_found' : 'pointed_to_line',
        })),
        most_attached_layer: 'judgment', unwritten_knowledge: clip(u(12), 200),
      },
      process_archaeology: {
        workflow: clip(u(14), 100),
        steps: [15, 16, 17].map((i, k) => ({ step: `step ${k + 1}`, originating_constraint: clip(u(i), 120), status: ['present', 'gone', 'unknown'][k] })),
      },
      assumption_ledger: { entries: [
        { belief: clip(u(18), 100) || 'first belief', category: 'role', tag: 'inherited' },
        { belief: clip(u(19), 100) || 'second belief', category: 'process', tag: 'defensive' },
        { belief: clip(u(20), 100) || 'third belief', category: 'contribution', tag: 'still_true' },
      ] },
      most_uncomfortable_entry: clip(u(21), 200),
      read_back: { inherited_sentence: clip(u(22), 200), defensive_sentence: clip(u(22), 200), response: clip(u(23), 200), done: true },
    });
  }

  if (state === 'RECONSTRUCTION') {
    if (n === 1) return 'Build: a full market-and-pricing analysis for your largest client, at a scale you lack the hours for. It was out of reach because it needs 40 hours of modelling. Who will see this when it\'s done?';
    if (n === 2) return 'Good.\n' + fence({ build_brief: { proposal: 'market-and-pricing analysis', accepted: true, what: 'Market and pricing analysis', why_out_of_reach: 'Needs 40 hours of modelling', seen_by: clip(u(2), 80), reproposals: 0 } }) + '\nI need context here: what is the history with this client?';
    if (n === 3) return 'Working. Is this still something you couldn\'t have done alone? When it is whole, attach or link it and confirm the date you will show it.';
    if (n === 4) return fence({ artifact: { link: clip(u(4), 200), description: 'Market and pricing analysis', shown_at: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) } }) + '\nWalk me through your three most recurring blocks of work in a typical week.';
    if (n === 5) return 'For each block: which layer you hold, which you delegate, where the handoff happens, and where judgment re-enters.';
    if (n === 6) return fence({ operating_model: { week: [
      { slot: 'Weekly client update', layer: 'execution', mode: 'delegate', handoff: 'agent drafts Monday', judgment_reenters: 'my edit before send' },
      { slot: 'Pricing decisions', layer: 'judgment', mode: 'hold', handoff: 'none', judgment_reenters: 'always mine' },
      { slot: 'Board prep', layer: 'execution', mode: 'delegate', handoff: 'agent builds deck', judgment_reenters: 'I choose the story' },
    ] } }) + '\nWhat I hold. Name it for your work.';
    if (n === 7) return 'What I delegate. Which one on Monday?';
    if (n === 8) return 'What I stop doing. At least one activity.';
    if (n === 9) return 'My tell-tale. One observable sign you have slipped back.';
    if (n === 10) return 'My next build. The first thing you will make with an agent after this session.';
    if (n === 11) return `Your statement: holds “${clip(u(7), 80)}”; delegates “${clip(u(8), 80)}”. Confirm it is yours.`;
    if (n === 12) return fence({ wedge_statement: { holds: clip(u(7), 200), delegates: clip(u(8), 200), stops: clip(u(9), 200), telltale: clip(u(10), 200), next_build: clip(u(11), 200) } }) + '\nDay 3: one commitment, a delegation you named.';
    if (n === 13) return 'Day 10: the tell-tale commitment.';
    if (n === 14) return 'Day 30: the second build and whether the operating model is in use.';
    return fence({ reentry_plan: { checkpoints: [
      { day: 3, commitment: clip(u(13), 200), linked_row: 'Weekly client update' },
      { day: 10, commitment: clip(u(14), 200) },
      { day: 30, commitment: clip(u(15), 200) },
    ] } }) + `\nYour tell-tale: ${clip(u(10), 200)}`;
  }

  if (state === 'REENTRY') {
    if (n === 1) return `Tell-tale and commitment for day ${day}, verbatim.\nDid it happen?`;
    if (n === 2) return 'Has the tell-tale shown up yet?';
    const no = /^no/i.test(u(2));
    const data = { day, commitment_done: !no, telltale_observed: /yes|seen|saw/i.test(u(3)), acted_on: clip(u(3), 160) };
    if (day === 30) Object.assign(data, { build_shipped: !no, seen_by: 'my director', model_in_use: no ? 'drifted' : 'held', statement: 'unchanged', platform_in_use: !no });
    return (day === 30 ? 'That\'s day 30. The statement is yours.' : 'Recorded.') + '\n' + fence({ checkin: data });
  }
  return 'Understood.';
}
