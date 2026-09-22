import { stableList } from '../normalize.js';
import type { Outcome } from '../types.js';

export interface TestInfo {
  outcome: Outcome;
  failCount: number | null;
  total: number | null;
  failing: string[];
  /** Output stated a test result at all. */
  sawTestResult: boolean;
}

/** `com.example.LoginTest > loginShowsHome[Pixel_6_API_34]` -> `com.example.LoginTest.loginShowsHome` */
function normalizeTestId(cls: string, name: string): string {
  const c = cls.trim().replace(/\s+/g, '');
  // Device/runner suffix in square brackets is environment, not identity.
  const n = name
    .trim()
    .replace(/\[[^\]]*(?:API|api|emulator|Pixel|Nexus|sdk|device)[^\]]*\]\s*$/i, '')
    .replace(/\s+/g, '');
  return `${c}.${n}`.replace(/\.+$/, '');
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse test outcomes from Gradle test output, Gradle instrumentation output,
 * or raw `am instrument` output.
 *
 * Returns `sawTestResult: false` when the text contains no test verdict, which
 * keeps a plain compile-only build from being scored as "0 failing tests".
 */
export function parseTestResults(text: string): TestInfo {
  const failing = new Set<string>();

  // Gradle per-test lines: `com.example.CartTest > totalIsSummed FAILED`
  for (const m of text.matchAll(
    /^\s*([\w$.]+(?:Test|Tests|Spec|IT|TestCase))\s*>\s*([^\r\n]+?)\s+(FAILED|FAILURE)\s*$/gim,
  )) {
    failing.add(normalizeTestId(m[1] ?? '', m[2] ?? ''));
  }

  // Gradle line without the Test-suffix convention.
  for (const m of text.matchAll(/^\s*([\w$.]{3,})\s*>\s*([^\r\n]{1,160}?)\s+FAILED\s*$/gim)) {
    const cls = m[1] ?? '';
    if (cls.startsWith(':')) continue; // that is a task, not a class
    failing.add(normalizeTestId(cls, m[2] ?? ''));
  }

  // JUnit textual runner: `1) totalIsSummed(com.example.CartTest)`
  for (const m of text.matchAll(/^\s*\d+\)\s*([\w$]+)\(([\w$.]+)\)\s*$/gim)) {
    failing.add(normalizeTestId(m[2] ?? '', m[1] ?? ''));
  }

  let total: number | null = null;
  let failCount: number | null = null;
  let sawTestResult = false;
  let outcome: Outcome = 'unknown';

  // `18 tests completed, 3 failed` (optionally `, 2 skipped`)
  const completed = text.match(/(\d+)\s+tests?\s+completed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+skipped)?/i);
  if (completed) {
    sawTestResult = true;
    total = num(completed[1]);
    failCount = num(completed[2]) ?? 0;
  }

  // `Tests run: 5, Failures: 1, Errors: 0, Skipped: 0`
  const junit = text.match(/Tests?\s+run:\s*(\d+)\s*,\s*Failures:\s*(\d+)(?:\s*,\s*Errors:\s*(\d+))?/i);
  if (junit) {
    sawTestResult = true;
    total = num(junit[1]);
    failCount = (num(junit[2]) ?? 0) + (num(junit[3]) ?? 0);
  }

  // `OK (5 tests)` — unambiguous pass from the JUnit runner.
  const ok = text.match(/^\s*OK\s*\((\d+)\s+tests?\)/im);
  if (ok) {
    sawTestResult = true;
    total ??= num(ok[1]);
    failCount ??= 0;
  }

  // `Tests on Pixel_6_API_34 failed: There was 1 failure(s).`
  const onDevice = text.match(/Tests? on .+ failed:\s*There (?:was|were)\s+(\d+)\s+failure/i);
  if (onDevice) {
    sawTestResult = true;
    failCount = num(onDevice[1]) ?? failCount;
  }

  // `Starting 5 tests on Pixel_6_API_34`
  const starting = text.match(/Starting\s+(\d+)\s+tests?\s+on\s+/i);
  if (starting) total ??= num(starting[1]);

  if (/FAILURES!!!/.test(text)) sawTestResult = true;
  if (/There were failing tests/i.test(text)) sawTestResult = true;

  if (failing.size) {
    sawTestResult = true;
    if (failCount === null) failCount = failing.size;
  }

  // Instrumentation crashed before reporting: `INSTRUMENTATION_RESULT: shortMsg=Process crashed.`
  if (/INSTRUMENTATION_(?:RESULT|CODE)/.test(text)) {
    sawTestResult = true;
    if (/shortMsg=.*crash|Process crashed/i.test(text)) outcome = 'error';
  }

  if (outcome === 'unknown' && sawTestResult) {
    if (failCount !== null && failCount > 0) outcome = 'fail';
    else if (/FAILURES!!!|There were failing tests|Tests? on .+ failed/i.test(text)) outcome = 'fail';
    else if (failCount === 0) outcome = 'pass';
  }

  return {
    outcome,
    failCount,
    total,
    failing: stableList(failing, 40),
    sawTestResult,
  };
}
