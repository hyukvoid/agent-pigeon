# Agent Pigeon

See how your coding agent actually worked.

**Local · Read-only · No API key · Nothing uploaded**

Agent Pigeon reads your local Claude Code and Codex session history and summarizes edits, recognized verification, FAIL→PASS loops, and session comparisons.

```bash
npx agent-pigeon flight
```

```text
⠀⠀⠀⠀⠀⠀⢀⣤⣴⣤⣄⠀⠀⠀
⠀⠀⠀⠀⠀⠀⣼⣿⣿⣽⣿⣄⠀⠀
⠀⠀⠀⠀⣠⣤⣿⣿⣿⣿⡿⠛⠉⠁
⣀⣀⣴⣿⡿⣿⣿⣿⣿⣿⣿⣷⠀⠀
⠈⠻⣿⡟⠛⣦⣉⠛⢿⣿⣿⣿⠁⠀
⠀⠀⠀⠉⠻⡿⠿⡿⠶⡿⠋⠁⠀⠀
⠀⠀⠀⠀⠒⠓⠂⠀⠒⠓⠂⠀⠀⠀
Agent Pigeon — Codex
  Session span: 63 min · 1 session

  READ      —                   N/A
  EDIT      ██████████████████  40
  VERIFY    ██████              14
  FAIL→PASS ███                 7

Final state
   ✓ recognized verification found

Local · Read-only · Nothing uploaded
```

Requires **Node.js ≥ 20.11**. Install once with `npm install -g agent-pigeon`.

## Reports

| Command | What it shows |
| --- | --- |
| `flight` | The latest session by default; use `--session <id-prefix>` to choose one. |
| `replay` | Corpus-wide activity, unverified implementation stretches, and recognized FAIL→PASS loops. |
| `compare <A> <B>` | Side-by-side facts, without scores or a winner. Claude Code and Codex sessions can be compared. |
| `share flight` / `share compare` | A self-contained SVG report printed to stdout. Redirect it to save. |

Flight reports include READ, EDIT, and recognized VERIFY counts, the largest debugging loop, most-touched file, longest stretch of coding without recognized verification, and final verification state. Reports are prompts to inspect, not grades.

## Privacy

Agent Pigeon reads only `~/.claude/projects` and `~/.codex/sessions`, in read-only mode. It never reads project source code, writes state or a cache, or transmits data. Reports contain aggregate counts and short session IDs, not source code, diffs, commands, or prompts.

Agent Pigeon is an independent local CLI and does not require or configure PigeonHub.

## Limits

Recognized verification covers build, test, and device commands Agent Pigeon can identify; custom checks may be missed. Session-stretch thresholds are heuristics, and reports are not verdicts. Windows 11 and Linux (Debian 12, Node 20, Docker) are tested; **macOS is untested**.

## License

MIT
