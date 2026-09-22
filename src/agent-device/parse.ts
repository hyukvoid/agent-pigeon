/**
 * agent-device output parser (POC-00 §8).
 *
 * agent-device (callstack, npm `agent-device`) is the candidate mobile
 * runtime evidence provider. POC-00 does NOT wrap or fork it: it only parses
 * recorded CLI output so evidence extraction can be developed without a
 * connected device.
 *
 * Parsed surfaces:
 *  - `agent-device snapshot`        -> screen signature (window identity)
 *  - `agent-device logs stop|start` -> crash signature (AndroidRuntime FATAL block)
 *
 * A recording is a plain text file with `$ agent-device ...` command lines
 * followed by their captured stdout.
 */

export interface AgentDeviceReading {
  /** Normalized window/screen identity, e.g. `Login`, or null when no snapshot. */
  screenSignature: string | null;
  /** Normalized crash identity, e.g. `NullPointerException:LoginViewModel#onSubmit`, or null. */
  crashSignature: string | null;
  /** True when a snapshot section was present (the app was actually observed). */
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
/** A token ending in Exception/Error followed by a colon, e.g. `java.lang.NullPointerException:`. */
const EXCEPTION_LINE = /([\w.$]*(?:Exception|Error))\s*:/u;
const STACK_FRAME_LINE = /(?:^|\s)at\s+([\w.$]+)\.([\w$<>]+)\(/u;
const FRAME_EXCLUDE_PREFIXES = ['android.', 'java.', 'com.android.', 'kotlin.', 'androidx.'];

/** `com.pigeon.demo.ui.login.LoginViewModel.onSubmit` -> `LoginViewModel#onSubmit` */
function normalizeFrame(qualified: string, method: string): string {
  const segments = qualified.split('.');
  const className = segments[segments.length - 1] ?? qualified;
  return `${className}#${method}`;
}

export function parseAgentDeviceRecording(text: string): AgentDeviceReading {
  const reading: AgentDeviceReading = {
    screenSignature: null,
    crashSignature: null,
    snapshotCaptured: false,
    crashDetected: false,
  };

  for (const section of splitIntoSections(text)) {
    const isSnapshot = section.command.startsWith('snapshot');
    const isLogs = section.command.startsWith('logs');

    if (isSnapshot) {
      reading.snapshotCaptured = true;
      for (const line of section.body.split('\n')) {
        const window = WINDOW_LINE.exec(line);
        if (window !== null) {
          reading.screenSignature = (window[1] ?? '').trim();
          break;
        }
      }
    }

    if (isLogs) {
      const bodyLines = section.body.split('\n');
      for (let i = 0; i < bodyLines.length; i++) {
        const line = bodyLines[i] ?? '';
        const exceptionMatch = EXCEPTION_LINE.exec(line);
        if (exceptionMatch === null) continue;
        reading.crashDetected = true;

        // First app-owned stack frame below the exception line.
        for (let j = i + 1; j < bodyLines.length; j++) {
          const frameLine = bodyLines[j] ?? '';
          const frame = STACK_FRAME_LINE.exec(frameLine);
          if (frame === null) continue;
          const qualified = frame[1] ?? '';
          if (FRAME_EXCLUDE_PREFIXES.some((prefix) => qualified.startsWith(prefix))) continue;
          const simpleName = (exceptionMatch[1] ?? '').split('.').pop() ?? '';
          reading.crashSignature = `${simpleName}:${normalizeFrame(qualified, frame[2] ?? '')}`;
          return reading;
        }
      }
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
