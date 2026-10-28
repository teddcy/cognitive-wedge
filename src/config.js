// All settings come from environment variables. See .env.example.
const env = process.env;
const bool = (v) => v === '1' || v === 'true';

export const config = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  dbPath: env.DB_PATH || './data/wedge.db',
  devMode: bool(env.DEV_MODE),
  // LLM
  apiKey: env.ANTHROPIC_API_KEY || '',
  model: env.WEDGE_MODEL || 'claude-sonnet-5-5',
  classifierModel: env.WEDGE_CLASSIFIER_MODEL || 'claude-haiku-5-5',
  mockLlm: bool(env.MOCK_LLM),
  // Program text
  agentName: env.AGENT_NAME || 'Wedge',
  retentionDays: Number(env.RETENTION_DAYS || 365),
  // Staff
  staffEmails: (env.STAFF_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  // Email
  smtpUrl: env.SMTP_URL || '',
  mailFrom: env.MAIL_FROM || 'Cognitive Wedge <no-reply@example.com>',
  // Optional: ask a platform-use question at day 30 (off until the platform link is confirmed)
  platformCheck: bool(env.PLATFORM_CHECK),
  platformName: env.PLATFORM_NAME || 'the platform',
};

export const PROMPT_VERSION = 'v0.2';
export const TEXT_VERSION = 'orientation-v0.2';
export const DATA_NOTICE_VERSION = 'notice-v0.1';
export const RUBRIC_VERSION = 'v0';

// Timing, in minutes (spec: Time budgets)
export const BUDGET = { ORIENTATION: 2, ONBOARDING: 7, RUPTURE: 8, DECONSTRUCTION: 13, RECONSTRUCTION: 35 };
export const FAST_STATES = { ORIENTATION: false, ONBOARDING: true, RUPTURE: false, DECONSTRUCTION: true, RECONSTRUCTION: true };
export const TOTAL_MINUTES = 65;
export const MINUTES_TO_BUILD = 30;
export const FAST_FRACTION = 0.3;
export const IDLE_MIN = 30;
export const RESUME_SECOND_AFTER_H = 24;
export const CHECKIN_DAYS = [3, 10, 30];
export const BUILD_NUDGE_MIN = 10;
export const BUILD_SOFT_LIMIT_MIN = 20;

export const DATA_NOTICE =
  'Your answers are stored so you can pick up where you left off and so the program team can see how the program is working. ' +
  'Named program staff can read your individual answers and report; nobody else can. Aggregate results contain no free text. ' +
  `Records are kept for ${Math.round((config.retentionDays) / 30.4)} months, and you can ask for yours to be deleted at any time. ` +
  'Nothing here is used to assess you or your job.';
