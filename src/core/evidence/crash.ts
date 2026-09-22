import type { CrashSignature } from '../types.js';
import { hash, normalizeMessage } from '../normalize.js';

/**
 * Frames we never treat as "the app's fault". The first frame outside this set
 * is what identifies a crash, because platform frames are identical across
 * unrelated bugs.
 */
const PLATFORM_PREFIXES = [
  'android.',
  'androidx.',
  'com.android.',
  'dalvik.',
  'libcore.',
  'java.',
  'javax.',
  'jdk.',
  'sun.',
  'kotlin.',
  'kotlinx.coroutines.internal.',
  'org.junit.',
  'junit.',
  'org.gradle.',
  'org.jetbrains.',
  'com.google.android.',
  'dagger.',
  'okhttp3.',
  'retrofit2.',
  'io.reactivex.',
];

function isPlatformFrame(fqn: string): boolean {
  return PLATFORM_PREFIXES.some((p) => fqn.startsWith(p));
}

/** `java.lang.IllegalStateException` / `com.example.MyException` */
const EXCEPTION_RE = /\b((?:[a-z][\w$]*\.){2,}[A-Z][\w$]*(?:Exception|Error|Throwable)(?:\$[\w$]+)?)\b/;

/** `at com.example.ui.CartScreen.render(CartScreen.kt:44)` */
const FRAME_RE = /^\s*(?:[EWID]\s+\w+\s*:\s*)?\s*at\s+([\w$.]+)\.([\w$<>]+)\s*\(([^)]*)\)/;

/** Strip logcat prefixes like `E AndroidRuntime: ` or `01-02 03:04:05.678  123  456 E TAG:`. */
function stripLogPrefix(line: string): string {
  return line
    .replace(/^\s*\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+[VDIWEF]\s+[^:]*:\s?/, '')
    .replace(/^\s*[VDIWEF]\/[^(]*\(\s*\d+\s*\):\s?/, '')
    .replace(/^\s*[VDIWEF]\s+[\w.$]+\s*:\s?/, '');
}

/**
 * Extract the dominant crash from arbitrary tool output (logcat dump, gradle
 * test output, instrumentation output). Returns null when there is no crash.
 *
 * The signature intentionally ignores line numbers so that moving code around
 * does not look like a different crash.
 */
export function extractCrash(text: string | null | undefined): CrashSignature | null {
  if (!text) return null;
  const raw = String(text);
  if (raw.length > 400_000) return extractCrash(raw.slice(0, 400_000));

  const lines = raw.split(/\r?\n/);

  // Anchor on a real crash marker. Without an anchor we do not guess, because a
  // stack trace mentioned in a log file is not the same as a crash happening.
  let anchor = -1;
  let isAnr = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (/FATAL EXCEPTION|FATAL SIGNAL|AndroidRuntime:\s*(?:FATAL|java\.|kotlin\.)/.test(l)) {
      anchor = i;
      break;
    }
    if (/\bANR in\s+[\w.]+/.test(l)) {
      anchor = i;
      isAnr = true;
      break;
    }
    if (/Process crashed\.|has died|Application .* has stopped|process .* crashed/i.test(l)) {
      anchor = i;
      break;
    }
  }

  if (anchor === -1) {
    // Instrumentation and unit-test output embeds the throwable without the
    // AndroidRuntime banner. Accept it only when an explicit failure marker is
    // present, so that a passing run mentioning an exception type is ignored.
    if (!/FAILED|FAILURES!!!|Exception|AssertionError/.test(raw)) return null;
    if (!/^\s*(?:at\s+[\w$.]+\.[\w$<>]+\s*\()/m.test(raw)) return null;
    anchor = 0;
  }

  if (isAnr) {
    const m = lines[anchor]?.match(/\bANR in\s+([\w.]+)/);
    const pkg = m?.[1] ?? 'unknown';
    const reasonLine = lines.slice(anchor, anchor + 6).find((l) => /Reason:/i.test(l));
    const message = normalizeMessage(reasonLine?.replace(/.*Reason:\s*/i, '') ?? null);
    return {
      exception: 'ANR',
      topFrame: pkg,
      message,
      hash: hash('anr', pkg, message),
    };
  }

  const scope = lines.slice(anchor, anchor + 200).map(stripLogPrefix);
  const scopeText = scope.join('\n');

  // Prefer the deepest `Caused by:` exception, which is the real fault.
  const causedBy = [...scopeText.matchAll(/Caused by:\s*(.+)/g)].map((m) => m[1] ?? '');
  const headerCandidates = causedBy.length ? [causedBy[causedBy.length - 1] ?? ''] : [];

  if (!headerCandidates.length) {
    for (const l of scope) {
      if (EXCEPTION_RE.test(l) && !/^\s*at\s/.test(l)) {
        headerCandidates.push(l);
        break;
      }
    }
  }

  const header = headerCandidates[0] ?? '';
  const exception = header.match(EXCEPTION_RE)?.[1] ?? 'UnknownThrowable';

  let message: string | null = null;
  const colon = header.indexOf(exception);
  if (colon >= 0) {
    const after = header.slice(colon + exception.length).replace(/^\s*:\s*/, '');
    message = normalizeMessage(after) || null;
  }

  // Find the first app-owned frame after the chosen header.
  const headerIdx = Math.max(0, scope.findIndex((l) => l === header));
  let topFrame: string | null = null;
  let fallbackFrame: string | null = null;
  for (let i = headerIdx; i < scope.length; i++) {
    const m = (scope[i] ?? '').match(FRAME_RE);
    if (!m) continue;
    const cls = m[1] ?? '';
    const method = m[2] ?? '';
    const fqn = `${cls}.${method}`;
    if (!fallbackFrame) fallbackFrame = fqn;
    if (!isPlatformFrame(cls)) {
      topFrame = fqn;
      break;
    }
  }
  topFrame ??= fallbackFrame;

  return {
    exception,
    topFrame,
    message,
    hash: hash('crash', exception, topFrame, message),
  };
}
