// Test setup: scripted agent, in-memory database, controllable clock.
process.env.MOCK_LLM = '1';
process.env.DEV_MODE = '1';
process.env.BASE_URL = 'http://localhost:3999';
process.env.STAFF_EMAILS = 'staff@example.com';
process.env.RETENTION_DAYS = '365';

export const { openDb, all, get } = await import('../src/db.js');
export const clock = await import('../src/clock.js');
export const engine = await import('../src/engine.js');
export const scheduler = await import('../src/scheduler.js');
export const auth = await import('../src/auth.js');

const ORIGIN = 'I learned this was my job from my first manager, who told me on my second week that clients trust the person who writes the words, not the tool. '
  + 'I carried that belief through every role since. It shaped how I spend my evenings, how I choose what to show people, and what I count as real work. '
  + 'I have rarely questioned whether the writing itself, rather than the thinking behind it, is what they trust.';

export function walkthrough() {
  return {
    orientation: ['It decides what I do, not how I do my current job.', 'Yes'],
    onboarding: [
      'writing proposals, reviewing contracts, planning quarters',
      'client judgment, pricing calls, reading the room',
      'firing people, final pricing, signing off on legal terms',
      ORIGIN,
      'Write the renewal proposal for our largest logistics client',
      'The brief is renewal, the audience is their CFO, the deadline is Friday.',
    ],
    rupture: [
      'ok',
      'Right: the structure. Wrong: no history with the client. Felt: uneasy and a bit exposed.',
      'I believed only I could write a proposal that the CFO would trust.',
      'My first manager, in my second week.',
      '2009',
    ],
    deconstruction: Array.from({ length: 22 }, (_, i) => `answer ${i + 2}`),
    reconstruction: [
      'Priya Nair, our CFO',
      'The client has had three account leads in two years.',
      'https://example.com/market-and-pricing-analysis',
      'Weekly client update, pricing decisions, board prep',
      'I hold the layer I own and delegate the other',
      'I decide which clients get the Q1 roadmap slot',
      'Drafting the weekly client update every Monday',
      'Reformatting the same status deck by hand each Friday',
      'I opened a blank document and started typing the update myself',
      'A pricing model for the Q1 renewals',
      'Yes, that is mine',
      'Delegate the weekly client update to the agent on Monday',
      'Check whether I opened a blank document on the day I should have briefed the agent',
      'Ship the pricing model and keep the operating model running',
    ],
  };
}

export async function say(sid, texts) {
  const out = [];
  for (const t of texts) out.push(await engine.handleUserMessage(sid, t));
  return out;
}

export function newSession(email = 'tester@example.com', track = 'commercial') {
  const p = engine.createParticipant(email, track);
  return { p, sid: engine.createSession(p.id) };
}
