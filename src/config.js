// Instance settings. Everything here is set in wrangler.jsonc under vars.SETTINGS;
// anything left out falls back to the defaults below. Per-minute rate limits
// are the `ratelimits` bindings in the same file.

export const DEFAULTS = {
  // Google Workspace domains allowed to sign in. [] means any Google account.
  // Add "gmail.com" to allow personal accounts alongside work ones.
  allowedDomains: [],
  // How long a sign-in lasts before Google is asked again.
  sessionHours: 24,
  // An event, its responses and its answers are deleted this many days after its last candidate day.
  retentionDays: 60,
  // Whether organizers may let people answer with just a name (no sign-in).
  // Defaults to false when allowedDomains is set, since that would let outsiders in.
  allowGuestResponses: null,
  maxEventsPerUserPerDay: 20,
  maxResponsesPerEvent: 300,
  maxQuestions: 12,
  // Anonymous answers reach the organizer in batches of at least this many people.
  anonBatch: 3,
  // The "Paraphrase to anonymize" button on written answers (needs the AI binding).
  aiReword: true,
  aiModel: '@cf/meta/llama-3.2-3b-instruct',
};

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const int = (v, fallback, min, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : fallback);

let memo = { raw: undefined, value: null };

export function settings(env) {
  if (memo.value && memo.raw === env.SETTINGS) return memo.value;
  let raw = env.SETTINGS ?? {};
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = {};
    }
  }
  const allowedDomains = [...new Set((Array.isArray(raw.allowedDomains) ? raw.allowedDomains : [])
    .map((d) => String(d).trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => DOMAIN.test(d)))];
  const value = {
    allowedDomains,
    sessionHours: Number(raw.sessionHours) > 0 ? Math.min(Number(raw.sessionHours), 24 * 30) : DEFAULTS.sessionHours,
    retentionDays: int(raw.retentionDays, DEFAULTS.retentionDays, 1, 3650),
    allowGuestResponses: typeof raw.allowGuestResponses === 'boolean' ? raw.allowGuestResponses : allowedDomains.length === 0,
    maxEventsPerUserPerDay: int(raw.maxEventsPerUserPerDay, DEFAULTS.maxEventsPerUserPerDay, 1, 10_000),
    maxResponsesPerEvent: int(raw.maxResponsesPerEvent, DEFAULTS.maxResponsesPerEvent, 2, 5000),
    maxQuestions: int(raw.maxQuestions, DEFAULTS.maxQuestions, 0, 50),
    // A "batch" of one would be no anonymity at all.
    anonBatch: int(raw.anonBatch, DEFAULTS.anonBatch, 2, 100),
    aiReword: raw.aiReword !== false,
    aiModel: typeof raw.aiModel === 'string' && raw.aiModel.startsWith('@') ? raw.aiModel : DEFAULTS.aiModel,
  };
  memo = { raw: env.SETTINGS, value };
  return value;
}

/** Whether this Google account may sign in to this instance at all. */
export function signInAllowed(user, s) {
  if (!s.allowedDomains.length) return true;
  return domainAllowed(user, s.allowedDomains);
}

/**
 * `hd` is Google's assertion that the account belongs to that Workspace domain.
 * An email suffix alone isn't proof, except for gmail.com, which Google owns.
 */
export function domainAllowed(user, domains) {
  if (!user) return false;
  const emailDomain = String(user.email || '').split('@').pop();
  return domains.some((d) => d === user.hd || (d === 'gmail.com' && emailDomain === 'gmail.com'));
}
