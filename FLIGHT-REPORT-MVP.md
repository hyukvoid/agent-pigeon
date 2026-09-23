# Agent Pigeon — `flight` Report MVP

- Date: 2026-09-23
- Branch: `poc/v0.1-rc` (feature work on top of the release line; `release/v0.1-replay-only` `99973dd` remains the tagged-base lineage)
- Final state: **102/102 tests pass** (96 prior + 6 new flight/parsers tests), clean build, package re-validated

## Final CLI

```
agent-pigeon flight [options]     Flight report for the most recent coding session
agent-pigeon replay [options]     Analyze all local agent history
agent-pigeon --help / --version
```

`flight` options: `--session <id-prefix>` (explicit session selection), `--json`,
`--claude-dir` / `--codex-dir` overrides. Default = the most recent session with
implementation activity, ordered by wall-clock session end (`lastEventMs`).

## Example real output (organic Codex session — mobile/gradle work)

```
🐦 Agent Pigeon — Codex
  63 min · 1 session

  READ                          0
  EDIT      ██████████████████  40
  VERIFY    ██████              14
  FAIL→PASS ███                 7

🔁 Biggest debugging loop
   FAIL → edit → FAIL → edit → FAIL → edit → FAIL → edit → PASS → edit → FAIL → edit → PASS

Final state
   ✓ recognized verification found

Local · Read-only · Nothing uploaded
```

Organic Claude session (`415efbff`):

```
🐦 Agent Pigeon — Claude Code
  8 min · 1 session

  READ      █████████████       8
  EDIT      ██████████████████  11
  VERIFY                        0

🔥 Most touched file
   …/src/components/home/DashboardPreview.tsx · 10 touches

⏱ Longest coding streak
   11 implementation changes
   without recognized verification

Final state
   · no recognized verification
```

(`--json` adds `source`, `sessionId8`, `longestUnverifiedStreak`,
`mostTouchedFile`, `finalState` for automation.)

## Metrics used — all reconstructed from existing parsed data

| Metric | Source | Notes |
| --- | --- | --- |
| Duration | first→last timestamped event, wall-clock span | resumed sessions span gaps; labeled as span |
| READ / EDIT / VERIFY bars | observer/replay event counts per tool family | READ only populated for Claude histories (Codex reads happen inside `exec` JS — not attributable per-file) |
| FAIL→PASS | verification outcomes across consecutive attempts | a passing run infers 0 failures even without a parsed count |
| Most touched file | highest-touch display path (reads + edits per path) | "most touches" interpretation, documented |
| Longest coding streak | longest run of consecutive unverified attempts, sized by implementation changes | same signal VERIFY_FIRST uses live |
| Final state | last recognized verification outcome | pass / failed / none |

## Metrics rejected (and why)

- **Token burn per window** — reconstructed deltas proved unreliable (duplicate
  cumulative streams inflated one window to "8.8 M tokens"). Excluded.
- **Dead-end windows** — signature-based detection produced wrapper-hash false
  positives; retracted in POC-04C. Not shown.
- **Subjective chaos score** — replaced by the transparent "most touches" count.
- **Per-file reads for Codex** — Codex reads happen inside exec JS blobs; only
  Claude histories attribute reads per file. Omitted for Codex flights rather
  than fabricated.

## Privacy / read-only verification

- Flight parses with **fingerprints disabled**: no secret file is created or read,
  no HMAC key exists on the replay path at all.
- Writes **nothing anywhere** (verified: repository and history trees byte-identical
  across a flight run; repo `git status` unchanged).
- **No network** code on the path.
- Displayed paths are repo-relative or last-4-segments with a `…` prefix —
  home-directory names never surface (parser `displayPath` + `…/` cap, tested).
- Session identifiers are 8-char prefixes only.

## README changes

Hero replaced: "See how your coding agent actually worked." → `agent-pigeon
flight` with a realistic terminal example first; replay/verification
explanation moved below. No supervisor/watchdog/proof-system framing.

## Tests

102/102 total. New/updated for flight:
- turn-aware selection ordering (newest wall-clock session first)
- display-path sanitization (drive strips, repo-relative, ≤4 segments, `…` cap)
- flight on organic Codex session matches expected shape (loops, final state)
- CLI: `flight --session`/`--json` behavior; zero-activity empty-state message
- Codex privacy test re-scoped: patch bodies and absolute paths still forbidden;
  repo-relative display paths explicitly allowed (they are the feature)

## Package validation

- `npm pack`: 29 files / 37.5 kB — replay + flight runtime only; no
  experimental live code, no fixtures, no research docs.
- Clean temp-dir install of the packed tarball → `agent-pigeon flight` runs
  from the installed location (verified earlier for replay; same layout).

## Strongest visual element

The **FAIL→PASS debugging loop bar + loop shape line** — it shows real
agent-work texture (a 7-step loop with two mid-loops and a final pass) that no
raw diff view conveys.

## Weakest visual element

The **READ bar is 0 for all Codex sessions** (Codex reads happen inside exec
JS, not attributable per-file) — a Claude-vs-Codex asymmetry that is visible
in side-by-side comparison. Also the session-end wall-clock "duration" spans
resume gaps (an 809 h session is really days of separate work) — labeled as a
span, but easy to misread at a glance.

## Session-selection note

`--session <id-prefix>` uses existing 8-char session identifiers; default =
newest wall-clock coding session. No interactive TUI, per scope.
