# Agent Pigeon

**See how your coding agent actually worked.**

```bash
$ agent-pigeon flight

🐦 Agent Pigeon — Codex
  63 min · 1 session

  READ                          0
  EDIT      ██████████████████  40
  VERIFY    ██████              14
  FAIL→PASS ███                 7

🔁 Biggest debugging loop
   FAIL → edit → FAIL → edit → PASS

Final state
   ✓ recognized verification found

Local · Read-only · Nothing uploaded
```

## Why

Coding agents produce enormous amounts of activity. Activity is not progress.
The cheapest question you can ask about an agent session is:

> after the code changed, did anything ever run that could prove the change worked?

Agent Pigeon answers it from your existing session history — no configuration,
no API keys, no cloud.

## Compare two sessions

```bash
$ agent-pigeon compare <sessionA> <sessionB>

                        Claude Code 415efbff   vs   Codex 019f2132

  Session span              8 min   /   63 min
  EDIT                      11   /   40
  Recognized verification   0   /   14
  READ (attributed)         8   /   N/A

  · Codex ran more recognized verification (14 vs 0).
  Read-only · nothing stored or uploaded
```

Factual side-by-side counts — no scores, no winner, no AI judgment.

## Install & run

Requires Node ≥ 20.11.
Validated on **Windows 11** and **Linux (Debian 12, Node 20, Docker, offline)**.
macOS is untested.

```bash
git clone https://github.com/hyukvoid/agent-pigeon && cd agent-pigeon
npm install                       # builds automatically
npx agent-pigeon flight           # flight report for your most recent session
npx agent-pigeon replay           # …or the full multi-session verification report
```

Options: `--session <id-prefix>` (pick a session) · `--source claude|codex|all` ·
`--json` · `--claude-dir` / `--codex-dir` to override history locations.

## What it shows

- **READ / EDIT / VERIFY bars** — how much reading, code changing, and
  recognized verifying happened.
- **Debugging loop** — the FAIL → edit → FAIL → … → PASS shape of real
  fix-and-verify work.
- **Unverified implementation stretches** — 3+ separate model turns of code
  changes with **no recognized verification** in between. Prompts to inspect,
  not verdicts: Agent Pigeon does not know your project's definition of proof.
- **Recognized verification loops** — verification failed, then passed:
  healthy debugging, reported so the distinction is deliberate.

## What replay adds

`agent-pigeon replay` runs the same pipeline across **all** your local
sessions and reports corpus-wide activity, unverified implementation
stretches, and healthy fail→pass verification loops. `--json` for
automation.

## What it inspects

| History | Status in v0.1 |
| --- | --- |
| Claude Code (`~/.claude/projects`) | **parsed** |
| Codex (`~/.codex/sessions`, rollout JSONL) | **parsed** |
| Kiro / other agents / other formats | not parsed |

Only these directories are read, read-only. Your projects' source code is
not read.

## Privacy

- **Reads:** only the history directories above, read-only.
- **Persists:** nothing. Flight and replay write no files, create no state,
  keep no cache.
- **Transmits:** nothing. There is no network code in either path.
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
