# Agent Pigeon

**Different code isn't progress.**

Agent Pigeon checks whether your coding agent collects **proof** — builds, tests, device
runs — while it works, instead of just counting how much code it changed.

```bash
git clone <this repository> && cd agent-pigeon
npm install && npm run build
npx agent-pigeon replay          # ← start here: read-only, nothing to configure
```

> Your agent made 62 changes and never ran a single test.
> You didn't need an AI to notice that. You needed a pigeon.

---

## What it does

**1. Replay (zero setup).** Agent Pigeon reads your local Claude Code / Codex session
history (read-only) and answers one question per session:

- *Did the agent verify its changes — build, test, or device run — or just keep patching?*

It reports **verification debt**: stretches where the agent changed code again and again
without collecting any evidence. In one internal corpus of 350 real sessions, the largest
debt window was **62 consecutive code changes with zero verification runs**.

**2. Live governor (optional).** During real coding sessions, a lightweight hook records
what the agent *did* (build/test/device verification — never the code itself), and after a
tool batch the governor may add **one factual reminder** to the agent's context:

```
Agent Pigeon

3 materially different implementation changes were made without collecting
new verification evidence.

Verify the current app before another implementation change.
```

That is the only intervention in v0.1. It fires **once per debt episode**, never on
productive debugging loops (fail → fix → pass stays silent), and never says "you're stuck"
or "your approach is wrong" — because a reminder can't know that.

## Install

Requires Node ≥ 20.11.

```bash
git clone <this repository>
cd agent-pigeon
npm install && npm run build

# 30-second first value — analyze your existing local history (read-only):
npx agent-pigeon replay
```

Enable the live governor in the current project:

```bash
npx agent-pigeon init          # adds two hooks to ./.claude/settings.json
npx agent-pigeon init --global # or for all projects (~/.claude/settings.json)
npx agent-pigeon init --dry-run# inspect before writing
npx agent-pigeon remove        # clean removal, anytime
```

`init` merges into your existing Claude settings and never touches unrelated
configuration. Everything it writes is visible in the settings file.

## What replay tells you

```
Agent Pigeon — replay

  Scanned                   367 sessions (claude 10 · codex 357)
  Sessions with attempts    73
  Implementation attempts   297
  Implementation changes    4,560
  Verification runs         392

Verification debt — 28 window(s)
  Changes made without running anything that could prove they worked.

Productive verification loops — 2 window(s)
  Verification failed, then passed. Healthy debugging: no warnings issued.

Read-only analysis. Nothing was modified, stored, or uploaded.
```

## Trust

- **Reads:** local Claude Code / Codex session files, read-only.
- **Stores:** small counters, booleans and short digests. Raw source, diffs, commands,
  prompts, reasoning and transcripts are **never persisted** — they are hashed in memory
  and discarded.
- **Hashes:** change identities are `HMAC-SHA256` digests (128-bit) keyed by a per-install
  random secret that never leaves your machine. Fingerprints are still *sensitive
  metadata* — they commit your session to "the same change happened again", which is
  exactly what the governor needs and nothing more.
- **Sends:** nothing. There is no network access, no telemetry, no model API.
- **Intervenes:** `VERIFY_FIRST` only — one factual reminder per debt episode.
  No blocking, no nudge storms, no "you're stuck".
- **Fails open:** if Agent Pigeon breaks, it goes quiet. Your agent never notices.
- **Removes cleanly:** `agent-pigeon remove` (or delete the hooks from your settings).

## Android / mobile

Mobile is the flagship deep adapter: verification classification already recognizes
gradle, adb, logcat, emulator and agent-device activity, and the research prototypes
include live device/runtime evidence collection (screenshots, crash signatures) via
[agent-device](https://github.com/callstack/agent-device). No Android tooling is required
for core replay/live functionality — install mobile tooling only if you want device-level
proof for Android work.

## Not in v0.1 (on purpose)

- RETHINK-style "your approach is failing" messages — needs stronger real-world evidence.
- Any model/LLM dependency — deterministic signals decide everything.
- Telemetry, dashboards, hosted anything.

Known limitations: the live warning's effect on real Claude sessions is not yet measured;
Codex sessions recorded with Windows-sandbox launch failures are filtered out (they are
not verification evidence); failure signatures are deliberately conservative.

## Development

```bash
npm test          # 77 tests: parsers, fingerprints, governor, CLI, privacy invariants
npm run demo      # runs the original three-scenario demo on bundled fixtures
```

Architecture and research history: see `POC-00.md` … `POC-04C.md` in the repository.

## License

MIT
