# flight

```bash
agent-pigeon flight [--session <id-prefix>] [--json]
```

Flight summarizes one coding session: reads, edits, recognized verification,
debugging loops, unverified stretches, and the final verification state.

## Which session it picks

By default, the most recent session with implementation activity, ordered by
wall-clock session end (a resumed session counts from its latest turn;
histories without wall-clock timestamps fall back to relative event order).
Use `--session <id-prefix>` to select any session by its 8-character id.
When other candidates exist, flight mentions the count on stderr.

`--json` prints the same facts for automation: `source`, `sessionId8`,
`duration`, `reads`, `edits`, `recognizedVerificationRuns`, `debuggingLoop`,
`longestUnverifiedStreak`, `mostTouched`, `finalState`.

## What the numbers mean

| Line | Meaning |
| --- | --- |
| Session span | Wall-clock span from first to last event. Resumed sessions include the gap between sittings, so one span can cover days of separate work. |
| READ | Attributed file reads. Only Claude Code histories record reads as distinct tool calls; Codex reads happen inside `exec` code, so they show as `N/A`. |
| EDIT | Implementation edits made during the session. |
| VERIFY | Recognized verification runs — build, test, and device commands Agent Pigeon can identify. |
| FAIL→PASS loop | Longest run of verification outcomes across consecutive attempts, e.g. `FAIL → edit → FAIL → edit → PASS`. |
| Longest coding streak | Longest run of consecutive implementation changes without recognized verification. |
| Most touched file | The path with the most touches (reads and edits), shown as a shortened display path. |
| Final state | What the last recognized verification did: found, failed, or none found. |

Values: `0` is a measured zero, `N/A` means the value cannot be attributed
for that session type (Codex file reads), and `—` means no such value exists.

Session ids are 8-character prefixes. Reports are read-only and aggregate —
see the Privacy section of the README.
