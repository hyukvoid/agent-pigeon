// POC-04C survey #2 — content-signal classification of exec-JS programs.
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
const sidByFile = new Map();
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const line of text.split('\n')) {
    if (line.includes('"session_meta"')) {
      try {
        const o = JSON.parse(line);
        if (o.payload?.id) sidByFile.set(f, String(o.payload.id).slice(0, 8));
      } catch {}
      break;
    }
  }
}

const WRITES = /writeFileSync|writeFile\(|appendFileSync|rmSync|unlinkSync|renameSync|cpSync|mkdirSync/;
const VERIF = /\b(npm (?:run )?test|pnpm (?:run )?test|yarn test|node --test|pytest|jest|vitest|go test|cargo test|gradlew?[^\s]*\s|adb\s|agent-device\s|playwright|tsc\b|npm run build\b|make\b|cmake\b)/i;

const sessions = new Map(); // sid -> {writes, verif, calls, both}
let callsTotal = 0;
let writesCalls = 0;
let verifCalls = 0;
let bothCalls = 0;
let neitherCalls = 0;
const verifInnerCount = {};

for (const f of files) {
  const sid = sidByFile.get(f) ?? 'unknown';
  if (!sessions.has(sid)) sessions.set(sid, { writes: false, verif: false, calls: 0, both: false });
  const s = sessions.get(sid);
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
      callsTotal++;
      s.calls++;
      const writes = WRITES.test(p.input);
      const verif = VERIF.test(p.input);
      if (writes) writesCalls++;
      if (verif) {
        verifCalls++;
        const m = VERIF.exec(p.input);
        const inner = (m?.[1] ?? m?.[0] ?? '?').slice(0, 24);
        verifInnerCount[inner] = (verifInnerCount[inner] ?? 0) + 1;
      }
      if (writes && verif) bothCalls++;
      if (writes) s.writes = true;
      if (verif) s.verif = true;
      if (!writes && !verif) neitherCalls++;
    }
    if (o.type === 'response_item' && p?.type === 'custom_tool_call' && p.name === 'apply_patch') {
      s.writes = true; // apply_patch is implementation too
    }
  }
}

let usable = 0;
let writesOnly = 0;
let verifOnly = 0;
let bothSessions = 0;
for (const s of sessions.values()) {
  if (s.writes && s.verif) {
    bothSessions++;
    usable++;
  } else if (s.writes) writesOnly++;
  else if (s.verif) verifOnly++;
}

console.log(JSON.stringify({
  execCalls: callsTotal,
  writesCalls,
  verifCalls,
  bothCalls,
  neitherCalls,
  totalSessionsWithExec: sessions.size,
  sessions_writesAndVerification: bothSessions,
  sessions_writesOnly: writesOnly,
  sessions_verificationOnly: verifOnly,
  topVerifInner: Object.fromEntries(Object.entries(verifInnerCount).sort((a, b) => b[1] - a[1]).slice(0, 12)),
}, null, 1));
