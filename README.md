# Agent Pigeon

**Did your coding agent collect proof after changing the code?**

Agent Pigeon replays your local coding-agent history and reports whether
implementation activity was followed by **recognized verification evidence** —
builds, tests, or device runs — or whether the agent kept changing code
without ever checking that anything works.

```
$ agent-pigeon replay

Agent Pigeon — replay

  History scanned                   405 sessions
  Sessions with code changes        94
  Implementation attempts           442
  Implementation changes            4,588
  Recognized verification runs      591

Unverified implementation stretches — 13
  Stretches where the agent changed code across 3+ separate turns
  without any recognized verification (build / test / device run).
  · codex session 019e6e63 · 17 turns · high confidence
  …

Recognized verification loops — 3
  Verification failed, then passed. Healthy debugging — no findings here.

Read-only: nothing was modified, stored, or uploaded.
```

## Why

Coding agents produce enormous amounts of activity. Activity is not progress.
The single cheapest question you can ask about an agent session is:

> after the code changed, did anything ever run that could prove the change worked?

Agent Pigeon answers that question from your existing session history —
no configuration, no API keys, no cloud.

## Install & run

Requires Node ≥ 20.11. Windows / Linux / macOS (see Support matrix).

```bash
git clone https://github.com/hyukvoid/agent-pigeon && cd agent-pigeon
npm install                       # builds automatically
npx agent-pigeon replay
```

Options: `--source claude|codex|all` · `--json` · `--claude-dir` / `--codex-dir`
to override history locations. `--json` prints the sanitized aggregate for automation.

## What replay inspects

| History | Status in v0.1 |
| --- | --- |
| Claude Code (`~/.claude/projects`) | **parsed** |
| Codex (`~/.codex/sessions`, rollout JSONL) | **parsed** |
| Kiro / other agents / other formats | not parsed |

Only these directories are read, read-only. Your projects' source code is
not read.

## What the output means

- **Implementation changes / turns** — tool calls (and model turns) that
  changed code.
- **Recognized verification runs** — build / test / device commands Agent
  Pigeon can identify (`npm test`, `gradlew`, `pytest`, `adb`, `agent-device`,
  `tsc`, …).
- **Unverified implementation stretches** — 3+ separate model turns of code
  changes with **no recognized verification** in between. These are prompts
  to inspect, not verdicts: Agent Pigeon does not know your project's
  definition of proof. Custom verification (smoke runs, bespoke scripts) may
  be invisible to it — the report says "recognized verification" for that
  reason.
- **Recognized verification loops** — verification failed, then passed:
  healthy debugging, reported so you know the distinction is deliberate.

## Privacy

- **Reads:** only the history directories above, read-only.
- **Persists:** nothing. Replay writes no files, creates no state, keeps no
  cache. Every run recomputes from your history.
- **Transmits:** nothing. There is no network code in the replay path.
- **Output:** aggregate counts and short session identifiers. No source
  code, no diffs, no commands, no prompts.

## Experimental / research

A live VERIFY_FIRST governor (a hook that would remind the agent mid-session)
was built and dogfooded, then **intentionally withheld from v0.1**: in a real
dogfood its warnings were not useful enough (it could not recognize all forms
of verification, producing false positives). The code and the full research
history are preserved under `experimental/`, `docs/research/` and the POC
reports in this repository. See [docs/research/SUMMARY.md](docs/research/SUMMARY.md).

## License

MIT
