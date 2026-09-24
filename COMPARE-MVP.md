# Agent Pigeon — Compare MVP

- Date: 2026-09-23
- Branch: `poc/v0.1-rc` @ `d2e99b6`
- Final regression: **102/102 tests pass**

## Final CLI

```
agent-pigeon compare <sessionA-id> <sessionB-id>
```

Side-by-side comparison of two sessions using the same trusted metrics as
`flight`. No winner, no score, no ranking — just the numbers and what they
literally say.

## Unavailable-metric handling

- READ: Codex sessions cannot attribute reads per file → shown as `N/A`.
- If neither session has a most-touched file → `—`.
- If neither session has verification → FAIL→PASS shape omitted.

The distinction between "observed zero" (e.g. `0` for a passing test count)
and "unavailable" (`N/A` or `—`) is preserved throughout. This matters because
"0" means the tool observed a real verification that succeeded, while `—`
means the tool couldn't measure it.

## Real comparison output (Codex vs Codex)

```
Agent Pigeon — compare

                        Codex 019f2132   vs   Codex 019e835d

  Session span              63 min   /   809 h 9 min
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

The 809 h session span is honest: it includes the resume gap. The summaries
are factual, not evaluative.

## Privacy

Same guarantees as flight and replay. Compare reads only the two named
session files, computes counts in memory, and produces aggregate numbers.
No source code, diffs, commands, prompts, or transcript content.

## Package

29 files / 38.6 kB. No experimental code, no live governor, no POC docs.

## Summary

Compare works correctly for all test combinations. The factual summaries
avoid evaluative conclusions. The N/A convention preserves the distinction
between "observed zero" and "couldn't measure." The RLE compression makes
long debugging loops readable. The tool adds genuine value by making
session-to-session comparison trivial.
