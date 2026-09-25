# compare

```bash
agent-pigeon compare <sessionA-id> <sessionB-id>
```

Compare puts two sessions side by side using the same metrics as flight —
the numbers and what they literally say. No score, no ranking, no winner.
Both arguments are 8-character session-id prefixes; Claude Code and Codex
sessions can be compared against each other.

## Example

```text
Agent Pigeon — compare

                            Codex 019f2132   vs   Codex 019e835d

  Session span              63 min   /   33d 17 h*
  EDIT                      40   /   170
  Recognized verification   14   /   3
  FAIL→PASS shape           FAIL ×4 → edit → PASS → edit → FAIL → edit → PASS   /   —
  Longest unverified streak  —   /   91 changes / 1 att
  Most touched file         —   /   public/index.html (11)
  READ (attributed)         N/A   /   N/A

  · Codex ran more recognized verification (14 vs 3).
  · Codex made more implementation edits (170 vs 40).
  Read-only · nothing stored or uploaded
```

The summary lines only state factual differences (more verification, more
edits, different most-touched files) — never a winner.

## Missing values

- `N/A` — the metric cannot be attributed for that session type. READ is
  `N/A` for Codex sessions because Codex reads happen inside `exec` code, not
  as per-file tool calls.
- `—` — no such value for these sessions (no most-touched file, no parsed
  loop, no unverified streak). The FAIL→PASS shape row appears only when at
  least one side has a loop.
- `0` — a real, measured zero (for example zero recognized verification runs).

`0` means observed; `N/A` and `—` mean not measurable or not present. The
distinction is preserved everywhere in the report.

Session span is wall-clock between the first and last event and includes
resume gaps: a span of days usually means several sittings, not non-stop work.

## Privacy

Compare reads only the two named session files, computes counts in memory,
and prints aggregate numbers — no source code, diffs, commands, prompts, or
transcript content.
