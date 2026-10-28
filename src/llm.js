import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { mockComplete, mockClassify } from './mock-llm.js';

let client;
export const usingMock = () => config.mockLlm;

function api() {
  if (!config.apiKey) throw new Error('ANTHROPIC_API_KEY is not set (or set MOCK_LLM=1 to run the scripted stand-in agent).');
  client ||= new Anthropic({ apiKey: config.apiKey });
  return client;
}

// The API needs the first message to be from the user and roles to alternate.
export function normalizeMessages(msgs) {
  const out = [];
  for (const m of msgs) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += `\n\n${m.content}`;
    else out.push({ role, content: m.content });
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: '[session started]' });
  return out;
}

export async function complete({ system, messages, maxTokens = 2500 }) {
  const msgs = normalizeMessages(messages);
  if (usingMock()) return mockComplete({ system, messages: msgs });
  const res = await api().messages.create({ model: config.model, max_tokens: maxTokens, system, messages: msgs });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

const CLASSIFIER_SYSTEM = `You review ONE draft turn from an interview agent before the participant sees it. Reply with exactly one word.
Labels:
reassures: tells the person their work, value or role is safe or still needed; softens a gap; comforts them about the output (for example "it still needs your judgment", "of course it isn't perfect", "you bring something it can't").
advises: gives advice, an evaluation, or an interpretation of the person's answers or work; says what they should do or what something means.
steers: suggests a verdict or tag, offers one the person did not give, hints at a preferred answer, or words a question so that one answer is easier to give.
clean: none of the above.
Flag only the labels allowed for this module. If none apply, reply clean.`;

export async function classify(text, { allowed, lastUser }) {
  if (usingMock()) return mockClassify(text, allowed);
  const res = await api().messages.create({
    model: config.classifierModel,
    max_tokens: 10,
    system: CLASSIFIER_SYSTEM,
    messages: [{
      role: 'user',
      content: `Allowed labels: ${allowed.join(', ')}, clean.\n\nParticipant's last message:\n${lastUser || '(none)'}\n\nDraft agent turn:\n${text}`,
    }],
  });
  const word = res.content.map((b) => b.text || '').join('').toLowerCase();
  return [...allowed, 'clean'].find((l) => word.includes(l)) || 'clean';
}
