import type { Outcome } from '../types.js';

export interface RuntimeInfo {
  /** e.g. `com.example/.MainActivity` */
  reachedActivity: string | null;
  /** Launch/attach outcome when the output reports one. */
  outcome: Outcome;
  /** Reason the launch failed, normalized. */
  failureReason: string | null;
}

function normalizeComponent(raw: string): string {
  let s = raw.trim().replace(/^\{|\}$/g, '');
  // `com.example/com.example.ui.MainActivity` -> `com.example/.ui.MainActivity`
  const slash = s.indexOf('/');
  if (slash > 0) {
    const pkg = s.slice(0, slash);
    let cls = s.slice(slash + 1);
    if (cls.startsWith(pkg + '.')) cls = cls.slice(pkg.length);
    s = `${pkg}/${cls}`;
  }
  return s;
}

/**
 * Extract the runtime state the app actually reached, plus whether a launch
 * succeeded. This is the cheapest trustworthy "the app ran" signal available
 * from adb output, which is why v0.1 relies on it instead of screenshots or
 * UI automation.
 */
export function parseRuntime(text: string): RuntimeInfo {
  let reachedActivity: string | null = null;
  let outcome: Outcome = 'unknown';
  let failureReason: string | null = null;

  // Strongest signal: the system reports the window was actually drawn.
  const displayed = [...text.matchAll(/Displayed\s+([\w.]+\/[\w.$]+)/g)];
  if (displayed.length) {
    reachedActivity = normalizeComponent(displayed[displayed.length - 1]?.[1] ?? '');
    outcome = 'pass';
  }

  // `am start` structured output.
  if (/^\s*Status:\s*ok\s*$/im.test(text)) outcome = 'pass';

  const activityLine = text.match(/^\s*Activity:\s*([\w.]+\/[\w.$]+)/im);
  if (activityLine?.[1] && !reachedActivity) {
    reachedActivity = normalizeComponent(activityLine[1]);
  }

  // Current focus / resumed activity from dumpsys.
  if (!reachedActivity) {
    const focus = text.match(/(?:mCurrentFocus|mResumedActivity|topResumedActivity)[^\r\n]*?([\w.]+\/[\w.$]+)/);
    if (focus?.[1]) reachedActivity = normalizeComponent(focus[1]);
  }

  // Launch failures.
  const errLine = text.match(/^\s*Error(?:\s+type\s+\d+)?:\s*(.+)$/im);
  if (errLine?.[1]) {
    failureReason = errLine[1].trim().slice(0, 200);
    outcome = 'fail';
  }
  if (/Activity class \{[^}]*\} does not exist/i.test(text)) {
    failureReason ??= 'activity class does not exist';
    outcome = 'fail';
  }
  if (/Unable to (?:start|resolve) activity|Permission Denial|Intent has been denied/i.test(text)) {
    failureReason ??= 'unable to start activity';
    outcome = 'fail';
  }
  if (/^\s*(?:Failure \[|adb: failed to install)/im.test(text)) {
    const m = text.match(/Failure \[([^\]]+)\]/);
    failureReason ??= m?.[1] ?? 'install failed';
    outcome = 'fail';
  }
  if (/device (?:not found|unauthorized|offline)|no devices\/emulators found/i.test(text)) {
    failureReason ??= 'no usable device';
    // Environment problem, not app evidence.
    outcome = 'error';
  }

  return { reachedActivity, outcome, failureReason };
}

export type AdbKind = 'logcat' | 'launch' | 'instrument' | 'install' | 'dumpsys' | 'other';

/** Classify an adb-flavoured command. */
export function adbKind(command: string): AdbKind {
  if (/\blogcat\b/.test(command)) return 'logcat';
  if (/\bam\s+instrument\b|\binstrument\b/.test(command)) return 'instrument';
  if (/\bam\s+start\b|\bam\s+start-activity\b|\bmonkey\b/.test(command)) return 'launch';
  if (/\binstall(?:-multiple)?\b|\buninstall\b/.test(command)) return 'install';
  if (/\bdumpsys\b/.test(command)) return 'dumpsys';
  return 'other';
}

/** True when the command touches an Android device or emulator. */
export function isAdbCommand(command: string): boolean {
  return /(?:^|[|&;(\s])adb(?:\.exe)?\b|\bemulator(?:\.exe)?\b/.test(command);
}
