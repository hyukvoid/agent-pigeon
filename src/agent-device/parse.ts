/**
 * agent-device output parser (POC-00 §8, hardened against real CLI output in POC-01).
 *
 * agent-device (callstack, npm `agent-device`) is the candidate mobile
 * runtime evidence provider. POC-00 does NOT wrap or fork it: it only parses
 * recorded CLI output so evidence extraction can be developed without a
 * connected device. POC-01 validated the extraction against REAL emulator
 * captures (`fixtures/agent-device/real/`).
 *
 * Two surfaces are parsed:
 *  - `agent-device snapshot`  -> screen signature (page + normalized interactive-node set)
 *  - `agent-device logs`      -> crash signature (AndroidRuntime FATAL block)
 *
 * Noise rules (POC-01 §6): refs (`@e12`, `@e12~s4`), coordinates, flags
 * (`[scrollable]`) and section markers are stripped before hashing; capture
 * is expected to use `snapshot -i` so status-bar noise (clock, battery,
 * signal) is excluded structurally. Crash signatures keep only the exception
 * simple name plus the first app-owned frame, so PIDs/timestamps/addresses
 * never survive. Distinct crashes stay distinct: labels and frame identity
 * are preserved, never merged.
 */

import { createHash } from 'node:crypto';

export interface SnapshotReading {
  /** `Page:` line value, falling back to a legacy `# window "..."` line. */
  page: string | null;
  /** sha256-8 of the sorted normalized interactive-node lines; null when nothing was captured. */
  contentSignature: string | null;
  /** True when the output has no node lines (compact unchanged-ack or legacy recording). */
  unchangedAck: boolean;
}

export interface LogsReading {
  crashSignature: string | null;
  crashDetected: boolean;
}

export interface AgentDeviceReading {
  screenSignature: string | null;
  crashSignature: string | null;
  snapshotCaptured: boolean;
  crashDetected: boolean;
}

interface Section {
  command: string;
  body: string;
}

function splitIntoSections(text: string): Section[] {
  const sections: Section[] = [];
  const lines = text.split(/\r?\n/u);
  let current: Section | null = null;
  const bodyLines: string[] = [];

  for (const line of lines) {
    const match = /^\$\s+agent-device\s+(.+)$/u.exec(line);
    if (match !== null) {
      if (current !== null) current.body = bodyLines.join('\n');
      current = { command: (match[1] ?? '').trim(), body: '' };
      sections.push(current);
      bodyLines.length = 0;
    } else if (current !== null) {
      bodyLines.push(line);
    }
  }
  if (current !== null) current.body = bodyLines.join('\n');
  return sections;
}

const WINDOW_LINE = /^#\s+window\s+"([^"]+)"/u;
const PAGE_LINE = /^Page:\s*(.+)$/u;
/** A token ending in Exception/Error followed by a colon, e.g. `java.lang.NullPointerException:`. */
const EXCEPTION_LINE = /([\w.$]*(?:Exception|Error))\s*:/u;
const STACK_FRAME_LINE = /(?:^|\s)at\s+([\w.$]+)\.([\w$<>]+)\(/u;
const NODE_LINE = /^@e\d+(?:~s\d+)?\s+\[([^\]]+)\]\s*(.*)$/u;
const TRAILING_FLAGS = /(?:\s+\[[a-z-]+\])+$/gu;
const FRAME_EXCLUDE_PREFIXES = ['android.', 'java.', 'com.android.', 'kotlin.', 'androidx.', 'dalvik.'];

/** `com.pigeon.demo.ui.login.LoginViewModel.onSubmit` -> `LoginViewModel#onSubmit` */
function normalizeFrame(qualified: string, method: string): string {
  const segments = qualified.split('.');
  const className = segments[segments.length - 1] ?? qualified;
  return `${className}#${method}`;
}

/** Parse `agent-device snapshot` output (real CLI schema, validated in POC-01). */
export function readSnapshot(text: string): SnapshotReading {
  const lines = text.split(/\r?\n/u);

  let page: string | null = null;
  for (const line of lines) {
    const pageMatch = PAGE_LINE.exec(line);
    if (pageMatch !== null) {
      page = (pageMatch[1] ?? '').trim();
      break;
    }
    const windowMatch = WINDOW_LINE.exec(line);
    if (windowMatch !== null && page === null) {
      page = (windowMatch[1] ?? '').trim();
    }
  }

  const nodeLines: string[] = [];
  for (const line of lines) {
    const node = NODE_LINE.exec(line);
    if (node === null) continue;
    const role = node[1] ?? '';
    const rest = (node[2] ?? '').replace(TRAILING_FLAGS, '').trim();
    nodeLines.push(`[${role}] ${rest}`);
  }

  if (nodeLines.length === 0) {
    return { page, contentSignature: null, unchangedAck: true };
  }
  const digest = createHash('sha256').update(nodeLines.sort().join('\n')).digest('hex');
  return { page, contentSignature: digest.slice(0, 8), unchangedAck: false };
}

/** Parse `agent-device logs` (or any Android logcat) text for crash evidence. */
export function readLogs(text: string): LogsReading {
  const bodyLines = text.split(/\r?\n/u);
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i] ?? '';
    const exceptionMatch = EXCEPTION_LINE.exec(line);
    if (exceptionMatch === null) continue;

    const simpleName = (exceptionMatch[1] ?? '').split('.').pop() ?? '';
    // First app-owned stack frame below the exception line; framework-only
    // traces (e.g. `adb shell am crash`) fall back to the exception name.
    for (let j = i + 1; j < bodyLines.length; j++) {
      const frameLine = bodyLines[j] ?? '';
      const frame = STACK_FRAME_LINE.exec(frameLine);
      if (frame === null) continue;
      const qualified = frame[1] ?? '';
      if (FRAME_EXCLUDE_PREFIXES.some((prefix) => qualified.startsWith(prefix))) continue;
      return {
        crashSignature: `${simpleName}:${normalizeFrame(qualified, frame[2] ?? '')}`,
        crashDetected: true,
      };
    }
    return { crashSignature: simpleName, crashDetected: true };
  }
  return { crashSignature: null, crashDetected: false };
}

/** Parse a full POC-00-style recording ($-prefixed sections). */
export function parseAgentDeviceRecording(text: string): AgentDeviceReading {
  const reading: AgentDeviceReading = {
    screenSignature: null,
    crashSignature: null,
    snapshotCaptured: false,
    crashDetected: false,
  };

  for (const section of splitIntoSections(text)) {
    if (section.command.startsWith('snapshot')) {
      reading.snapshotCaptured = true;
      const snapshot = readSnapshot(section.body);
      reading.screenSignature = snapshot.contentSignature
        ? `${snapshot.page ?? 'screen'}#${snapshot.contentSignature}`
        : snapshot.page;
    } else if (section.command.startsWith('logs')) {
      const logs = readLogs(section.body);
      reading.crashDetected = logs.crashDetected;
      reading.crashSignature = logs.crashSignature;
    }
  }
  return reading;
}

/** Convert a reading into the runtime + verification part of AttemptEvidence. */
export function readingToEvidence(reading: AgentDeviceReading): {
  crashSignature: string | null;
  screenSignature: string | null;
  verificationPerformed: boolean;
} {
  return {
    crashSignature: reading.crashSignature,
    screenSignature: reading.screenSignature,
    verificationPerformed: reading.snapshotCaptured,
  };
}
