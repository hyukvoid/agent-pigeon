import { createHash } from 'node:crypto';

/** Short stable hash. 12 hex chars is plenty for within-session comparison. */
export function hash(...parts: (string | null | undefined)[]): string {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(p ?? '\u0000');
    h.update('\u0001');
  }
  return h.digest('hex').slice(0, 12);
}

const HOME_PATTERNS = [
  /[A-Za-z]:\\Users\\[^\\/:*?"<>|\r\n]+/g,
  /\/home\/[^\s/:]+/g,
  /\/Users\/[^\s/:]+/g,
];

/**
 * Collapse absolute paths to repo-relative-ish form and strip usernames.
 * Applied before anything is hashed, reported, or (optionally) sent to Jev.
 */
export function normalizePath(raw: string | null | undefined, cwd?: string | null): string | null {
  if (!raw) return null;
  let p = String(raw).replace(/\\/g, '/').trim();
  if (!p) return null;

  if (cwd) {
    const c = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
    if (c && p.toLowerCase().startsWith(c.toLowerCase() + '/')) {
      p = p.slice(c.length + 1);
    }
  }

  for (const re of HOME_PATTERNS) {
    p = p.replace(re, '~');
  }

  // Trim to the recognizable project-relative tail when still absolute.
  const anchor = p.match(/(?:^|\/)((?:app|core|data|domain|ui|feature|libs?|src)\/.*)$/);
  if (anchor?.[1] && /^(?:[A-Za-z]:|~|\/)/.test(p)) {
    p = anchor[1];
  }

  return p.replace(/^\.\//, '');
}

/**
 * Normalize free-form output text so that equivalent failures compare equal:
 * strip timestamps, pids, hex addresses, durations and absolute paths.
 */
export function normalizeMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw);

  for (const re of HOME_PATTERNS) s = s.replace(re, '~');

  s = s
    .replace(/\\/g, '/')
    .replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<ts>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<ts>')
    .replace(/0x[0-9a-fA-F]+/g, '<hex>')
    .replace(/\b(?:pid|tid|uid)[=: ]+\d+/gi, '$1=<n>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|m|min|mins)\b/gi, '<dur>')
    .replace(/@[0-9a-f]{6,}/gi, '@<id>')
    .replace(/\s+/g, ' ')
    .trim();

  return s.length ? s : null;
}

/**
 * Normalize a shell command into a comparable shape: drop the leading path of
 * the executable, collapse whitespace, drop obviously volatile args.
 */
export function normalizeCommand(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  for (const re of HOME_PATTERNS) s = s.replace(re, '~');
  s = s.replace(/\\/g, '/');
  // ./gradlew, gradlew.bat, /abs/path/gradlew -> gradlew
  s = s.replace(/(?:^|(?<=[|&;(\s]))(?:[.~]?[\w./~-]*\/)?gradlew(?:\.bat)?\b/g, 'gradlew');
  return s.slice(0, 400);
}

/** Cap a list and sort it so set-equality is order independent. */
export function stableList(items: Iterable<string>, cap = 40): string[] {
  const seen = new Set<string>();
  for (const i of items) {
    const t = i.trim();
    if (t) seen.add(t);
  }
  return [...seen].sort().slice(0, cap);
}

/** Jaccard distance between two string sets. 0 = identical, 1 = disjoint. */
export function jaccardDistance(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  if (union === 0) return 0;
  return 1 - inter / union;
}

/** Keep a bounded, readable excerpt of tool output for the local report. */
export function excerpt(text: string | null | undefined, maxLines = 6, maxChars = 600): string | null {
  if (!text) return null;
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (!lines.length) return null;
  const out = lines.slice(0, maxLines).join('\n');
  return out.length > maxChars ? out.slice(0, maxChars) + '…' : out;
}
