/**
 * Presentation-layer formatting helpers for the Agent Pigeon UI.
 *
 * Deterministic string cleanup only — no inference, no storytelling. These
 * helpers never invent meaning; they remove transport noise (cd prefixes,
 * shell boilerplate) and cap length so evidence fits its row.
 *
 * Loaded as an ES module by the UI (`import ... from '/format.js'`) and
 * imported directly by node tests.
 */

const HARNESS_PATTERNS = [
  /^you are running inside\b/i,
  /^working directory\b/i,
  /^the following is the\b/i,
  /^set model to\b/i,
  /^<[^>]+>/,          // injected XML blocks (<environment_context> …)
  /^\/[a-z]/i,         // slash commands (/model)
  /^# /,               // injected markdown instruction files
];

/** True when a task string looks like harness/boilerplate text, not a task. */
export function looksLikeHarnessText(text) {
  return HARNESS_PATTERNS.some((p) => p.test(text.trim()));
}

/**
 * Clean a "last observed" label for display: strip cd/Set-Location transport
 * prefixes and shell noise, collapse whitespace, cap length. The underlying
 * evidence is never reworded into something stronger.
 */
export function cleanLastObserved(label, max = 48) {
  if (!label) return null;
  let s = label;
  s = s.replace(/cd\s+(?:"[^"]*"|'[^']*'|[^\s&]+)\s*&&\s*/gi, '');
  s = s.replace(/Set-Location\s+-LiteralPath\s+'[^']*'\s*;?\s*/gi, '');
  s = s.replace(/\$ProgressPreference\s*=\s*'[^']*';\s*/gi, '');
  s = s.replace(/^ran\s+/i, 'ran ');
  s = s.replace(/\s+/gu, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s.length > 0 ? s : null;
}

const api = { looksLikeHarnessText, cleanLastObserved };
export default api;
