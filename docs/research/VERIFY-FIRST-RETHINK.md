# VERIFY-FIRST Rethink — Policy Evidence Report (POC-04C.2)

- Date: 2026-09-22
- Branch: `poc/verify-first-rethink`
- Trigger: real Claude-in-Kiro dogfood produced **6 warnings — 0 useful, 4 false positives, 2 annoying**.
- Final regression: **91/91 tests pass** (user's dogfood fixes + turn-unit redesign + controlled FP evaluation).

## 1. Re-baselined corpus (corrected classifier — ORGANIC)

The npm-script-indirection fix (user-authored, test-backed: `npm run check/typecheck/ci` etc.
now count as verification; lint/format deliberately do not) recovered real evidence the old
classifier missed:

| Metric | Before fix (POC-04C) | Re-baselined |
| --- | --- | --- |
| Files / parsed sessions | 367 | **400** (corpus still growing — Codex in active use) |
| Sessions with tool activity | 77 | **97** |
| Usable sessions | 73 | **93** |
| Attempts | 297 | **441** |
| Verification events | 392 | **588** (+~200 recovered — under-reporting confirmed) |
| Productive windows | 2 | 3 (one newly recovered build fail→pass) |
| Debt candidates | 28 raw-call-based | **20 turn-based** (see §4) |

## 2. What the dogfood falsified

**Tool-call novelty ≠ implementation-attempt novelty.** Six warnings were produced by a rule
that counted distinct edit fingerprints. Three mechanism classes were identified and each
is now deterministically addressed:

1. **Multi-edit coherent changes** (impl + import fix + type fix; mirrored files) — N raw
   edits in one model turn are ONE logical attempt.
2. **Regression-test writing counted as implementation** — writing the test you need in
   order to verify is verification *preparation*.
3. **npm script indirection** — `npm run check` is real verification; missing it inflated
   debt (and hid 3 productive windows).

Also fixed (evidence-backed, user-authored, preserved with tests): **stale-lock self-heal**
(`LOCK_STALE_MS` — a killed process no longer permanently silences the governor + taxes
every later model call 1.5 s), and **unreadable-session accounting** in replay.

## 3. The unit of evidence: model TURNS (deterministic, no thresholds)

Measured across the organic corpus: inter-implementation gaps are **continuous** (p50 28.8 s,
p90 7.3 min; 73 % within 1 minute; no bimodal valley) → **no defensible time threshold exists**
(gap-based episode splitting: UNRESOLVED). But both sources carry deterministic **turn
boundaries**: assistant-message boundaries (Claude) and `turn_context` lines (Codex).

Revised rule (implemented in the OFFLINE replay analyzer only — the live governor is
untouched): **debt = ≥3 distinct implementation TURNS with no verification turn between
them**; test-only turns are neutral; a turn re-applying the same patch is not novel;
turn-unaware streams (current live events) produce **no warning** (precision-first).

## 4. Test-edit finding

Local organic sample: 0/11 Claude implementation events touch test paths (no data to
validate ecosystem-wide name matching — marked partially unresolved). Decision implemented:
test/spec/`__tests__`-only edits are **verification preparation** — they do not create
implementation turns. The Kiro dogfood's "wrote the regression test" false positive is
silent under this rule.

## 5. Batch/turn hypothesis — validated

The turn hypothesis survives every evaluation: coherent multi-file changes collapse to one
unit, while repeated distinct turns without verification still fire. Additionally, turn
counting scales honestly with session length (windows of 3–26 distinct unverified turns in
the re-baselined corpus).

## 6. FALSE-POSITIVE AUDIT — a second bug found and fixed

Auditing the new candidates exposed a **signature-coarseness bug**: Codex outputs begin/end
with harness wrapper lines ("Script failed", "Wall time N seconds", "Output:", "Script
error:", "Warning: truncated output"), so the old first-line/last-3 hashing made EVERY
failed command share one signature (`005acf21`, `da8e02ef`, `ed117502` — across unrelated
projects). Consequences:

- All 4 POC-04B/04C dead-end candidates — including the "confirmed" 6-patch HIGH window —
  were **FALSE POSITIVES** (wrapper hashing). POC-04B.md carries a correction banner.
- The "productive fail→pass" windows in the same sessions are **provisional** (their "fail"
  legs were partly Windows-sandbox launch failures, not code failures).
- Fixed: wrapper/diagnostic lines filtered pre-hash; signature = last 3 content lines;
  sandbox-launch-failed outputs downgrade to "no evidence". Regression tests added
  (false-signature + sandbox-false-verification).

**Net effect on outcome-identity findings:** on this Windows Codex corpus, dead-end and
fail/pass windows are currently UNRELIABLE (wrapper/truncation/sandbox dominate outputs).
Debt detection — absence of verification — does NOT depend on output identity and remains
sound. `tokensInWindow` deltas are likewise unreliable (duplicate cumulative streams;
per-attempt numbers like "8.8 M tokens" are artifacts) → token metrics stay out of v0.1.

## 7. Replay vs live

- **REPLAY:** reviewable later → MEDIUM-confidence evidence is still useful to a human.
  The turn-based rule is safe here: silent-by-default, human-audited output.
- **LIVE:** must not interrupt legitimate work. The revised turn/batch rule fixes the
  reported FP classes structurally (controlled reproductions of all three dogfood shapes
  are silent; genuine 3-turn no-verification work still fires), but it requires the
  live event stream to carry **batch/turn ordinals** (stamped at PostToolBatch) — a schema
  change the current shipped hooks do not have. Without it, the live governor must stay
  silent (implemented: turn-unaware streams produce no warnings — tested).

## 8. Strongest case for live / against live

**For:** the failure mechanisms are fully explained and mechanically fixed; controlled
reproductions of all reported FP classes are silent while genuine 3-turn debt fires;
organic re-baseline still finds strong debt (3–26 distinct unverified turns, e.g. 162-call
and 91-call windows); a next dogfood is cheap and would measure the fixed policy directly.
**Against:** zero useful warnings in the only live sample; outcome-identity mining is
unreliable on this platform (warnings can never explain *what* failed, only *that* nothing
was verified); replay delivers the same debt insight with zero interruption risk and zero
schema work; each live warning costs latency on the model path.

## 9. Remaining uncertainty

- Live behavior with the revised rule: never measured (needs batch-ordinal stamping + a
  dogfood run with Claude access).
- Test-path classification beyond common conventions (gradle `src/test` covered; other
  ecosystems unaudited).
- Turn boundaries for non-Claude/non-Codex sources; episode splitting on long resumes.
- Whether any clean-output corpus can produce reliable outcome identity for RETHINK.

## VERDICT (exactly one)

**REVISED LIVE POLICY WORTH NEXT DOGFOOD** — conditional and narrow:

1. v0.1 ships as built: replay is the product surface; `init` stays opt-in and is labeled
   experimental in the README (the current live stream stays turn-unaware and therefore
   silent — it cannot produce the dogfood's false positives anymore, but it also rarely
   fires).
2. Next implementation step (separate POC, user-gated): batch-ordinal stamping
   (PostToolBatch writes the ordinal; observer events carry it), then ONE dogfood run of
   the revised ≥3-distinct-turns rule.
3. Dogfood success bar: ≥1 useful warning, 0 false positives, productive sessions silent.
   Failure bar: any repeated-interruption pattern → live governor drops to
   REPLAY-ONLY (option B) without further tuning.

RETHINK: **KEEP DISABLED** (this sprint retracted the only real dead-end evidence and
showed the platform's output identity is unreliable). Jev: stays out of the MVP.
events.jsonl growth: recommendation only — size-cap rotation (~10 MB, keep newest) at the
next live change; not needed while live is experimental.
