// POC-04C survey — classify ALL Codex exec commands into action buckets.
// Prints bucket counts + program-name histograms only (no raw commands).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const files = walk(join(homedir(), '.codex', 'sessions'));

// Conservative implementation-edit signals (shell level)
const EDIT_PATTERNS = [
  [/sed\b[^|]*\s-i(?:\s|--)/, 'sed-in-place'],
  [/\bcat\s+[^|]*>\s*\S/, 'cat-redirect'],
  [/\btee\s/, 'tee'],
  [/>>/, 'append-redirect'],
  [/^eval\s+deduped\b/, 'eval-deduped'],
  [/\bpatch\s+-[pP]/, 'patch-cmd'],
  [/\bperl\b[^|]*-i\b/, 'perl-in-place'],
];

const FIRST_WORD_COUNT = {};
const bucketCounts = {};
const sessionsWithEditExec = new Set();
const sessionsWithVerification = new Set();
const sessionsWithApplyPatch = new Set();
let execTotal = 0;
let file = null;
let sessionFileMap = new Map(); // file -> session id (from session_meta)

// first pass: session ids per file
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    if (line.includes('"session_meta"')) {
      try {
        const o = JSON.parse(line);
        if (o.payload?.id) sessionFileMap.set(f, String(o.payload.id).slice(0, 8));
      } catch {}
      break;
    }
  }
}

for (const f of files) {
  const sid = sessionFileMap.get(f) ?? 'unknown';
  const text = readFileSync(f, 'utf8');
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o.payload;
    if (p === null || typeof p !== 'object') continue;
    if (o.type === 'response_item' && p.type === 'custom_tool_call' && p.name === 'exec' && typeof p.input === 'string') {
      execTotal++;
      const cmd = p.input.trim();
      const firstWord = (cmd.split(/\s+/)[0] ?? '?').replace(/^[.\d]*\s*/, '') || '?';
      FIRST_WORD_COUNT[firstWord] = (FIRST_WORD_COUNT[firstWord] ?? 0) + 1;
      for (const [pattern, name] of EDIT_PATTERNS) {
        if (pattern.test(cmd)) {
          bucketCounts[name] = (bucketCounts[name] ?? 0) + 1;
          sessionsWithEditExec.add(sid);
        }
      }
    }
    if (o.type === 'response_item' && p.type === 'custom_tool_call' && p.name === 'apply_patch') {
      sessionsWithApplyPatch.add(sid);
    }
  }
}

// verification-active sessions (reuse broad definition: any exec matching test/build/device)
const VERIF = /\b(npm (?:run )?test|pnpm (?:run )?test|yarn test|jest\b|vitest\b|pytest\b|node --test\b|playwright\b|go test\b|cargo test\b|gradlew?(?:\.bat)?\b[^|;&]*\btest\b|mvn\b[^|;&]*\btest\b|dotnet test\b|gradlew?(?:\.bat)?\s|gradle\s|mvn\s|make\b|cmake\b|tsc\b|npm run build\b|go build\b|cargo build\b|adb(?:\.exe)?\s|agent-device\s|emulator\s)/i;
for (const f of files) {
  const sid = sessionFileMap.get(f) ?? 'unknown';
  const text = readFileSync(f, 'utf8');
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o.payload;
    if (o.type === 'response_item' && p?.type === 'custom_tool_call' && p.name === 'exec' && typeof p.input === 'string') {
      if (VERIF.test(p.input)) sessionsWithVerification.add(sid);
    }
  }
}

const topFirst = Object.fromEntries(Object.entries(FIRST_WORD_COUNT).sort((a, b) => b[1] - a[1]).slice(0, 25));
console.log(JSON.stringify({
  execTotal,
  topFirstWords: topFirst,
  editBuckets: bucketCounts,
  sessionsWithEditExec: sessionsWithEditExec.size,
  sessionsWithApplyPatch: sessionsWithApplyPatch.size,
  sessionsWithVerification: sessionsWithVerification.size,
  overlapEditAndVerifSessions: [...sessionsWithEditExec].filter((s) => sessionsWithVerification.has(s)).length,
}, null, 1));
