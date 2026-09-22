import { normalizeMessage, normalizePath, stableList } from '../normalize.js';
import type { Outcome } from '../types.js';

export interface GradleBuildInfo {
  /** Whether the output clearly stated an outcome. */
  outcome: Outcome;
  durationMs: number | null;
  failedTasks: string[];
}

const DURATION_RE = /BUILD (?:SUCCESSFUL|FAILED) in ((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s\s*)?(?:\d+ms)?)/i;

function parseGradleDuration(s: string | undefined): number | null {
  if (!s) return null;
  let ms = 0;
  let matched = false;
  for (const [, num, unit] of s.matchAll(/(\d+)\s*(h|m|s|ms)\b/g)) {
    const n = Number(num);
    if (!Number.isFinite(n)) continue;
    matched = true;
    if (unit === 'h') ms += n * 3_600_000;
    else if (unit === 'm') ms += n * 60_000;
    else if (unit === 's') ms += n * 1000;
    else ms += n;
  }
  return matched ? ms : null;
}

/**
 * Determine build outcome from Gradle output text.
 *
 * Exit codes are not available in Claude Code transcripts, so this is the only
 * reliable source. It deliberately returns 'unknown' rather than guessing when
 * no explicit Gradle verdict line is present.
 */
export function parseGradleBuild(text: string): GradleBuildInfo {
  const failedTasks = stableList(
    [...text.matchAll(/>\s*Task\s+(:[\w:.-]+)\s+FAILED/g)].map((m) => m[1] ?? ''),
    20,
  );

  let outcome: Outcome = 'unknown';
  if (/^\s*BUILD SUCCESSFUL/m.test(text)) outcome = 'pass';
  if (/^\s*BUILD FAILED/m.test(text) || /^FAILURE: Build (?:failed|completed with)/m.test(text)) {
    outcome = 'fail';
  }
  // A configuration-phase blowup can fail without the usual banner.
  if (outcome === 'unknown' && /^\s*\*\s*What went wrong:/m.test(text)) outcome = 'fail';
  if (outcome === 'unknown' && failedTasks.length) outcome = 'fail';

  const durationMs = parseGradleDuration(text.match(DURATION_RE)?.[1]);

  return { outcome, durationMs, failedTasks };
}

/**
 * Kotlin and Java compiler diagnostics, normalized to `path:line: message` and
 * deduplicated. Column numbers are dropped because they churn without the
 * underlying problem changing.
 */
export function parseCompileErrors(text: string, cwd?: string | null): string[] {
  const out: string[] = [];

  // Kotlin: `e: file:///C:/proj/app/src/main/java/Foo.kt:12:5 Unresolved reference: bar`
  for (const m of text.matchAll(/^\s*e:\s*(?:file:\/\/)?(\S+?):(\d+):(?:\d+)?\s*(.+)$/gim)) {
    const p = normalizePath((m[1] ?? '').replace(/^\/+([A-Za-z]:)/, '$1'), cwd);
    const msg = normalizeMessage(m[3]);
    if (p && msg) out.push(`${p}:${m[2]}: ${msg}`);
  }

  // Java: `/proj/app/src/main/java/Foo.java:12: error: cannot find symbol`
  for (const m of text.matchAll(/^\s*(\S+\.java):(\d+):\s*error:\s*(.+)$/gim)) {
    const p = normalizePath(m[1], cwd);
    const msg = normalizeMessage(m[3]);
    if (p && msg) out.push(`${p}:${m[2]}: ${msg}`);
  }

  // Kotlin 2.x / KSP style: `Foo.kt:12:5: error: ...`
  for (const m of text.matchAll(/^\s*(\S+\.kts?):(\d+):(?:\d+:)?\s*error:\s*(.+)$/gim)) {
    const p = normalizePath(m[1], cwd);
    const msg = normalizeMessage(m[3]);
    if (p && msg) out.push(`${p}:${m[2]}: ${msg}`);
  }

  // AAPT / manifest / resource errors carry no line: keep the message alone.
  for (const m of text.matchAll(/^\s*(?:ERROR|error):\s*(.*?(?:resource|attribute|AndroidManifest).*)$/gim)) {
    const msg = normalizeMessage(m[1]);
    if (msg) out.push(`resource: ${msg}`);
  }

  return stableList(out, 30);
}

/** True when the command looks like it drives Gradle. */
export function isGradleCommand(command: string): boolean {
  return /\bgradlew?\b|\bgradle\b/.test(command);
}

/** Classify which Gradle verification this command represents. */
export function gradleTaskKind(command: string): 'unit_test' | 'instrumentation' | 'build' {
  if (/\bconnected\w*(?:AndroidTest|Test)\b|\bconnectedCheck\b|\bmanagedDevice\w*\b/i.test(command)) {
    return 'instrumentation';
  }
  if (/\btest[\w]*UnitTest\b|\btest\b|\bcheck\b|\bjacoco\w*\b/i.test(command)) {
    return 'unit_test';
  }
  return 'build';
}
