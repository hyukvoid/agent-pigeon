# Final Live VERIFY_FIRST Dogfood Gate — Report

- Date: 2026-09-23
- Branch: `poc/live-dogfood-gate`
- Role: I (the Claude model in this coding environment) acted as the coding agent; the
  experimental live governor (`hooks/governor-live.mjs` — watermark opportunity policy)
  and the real observer hook (`hooks/hook-posttooluse.mjs`) evaluated my actual tool
  batches through their real code paths.
- Evidence labels used below:
  - **CLAUDE_MODEL_BEHAVIOR** — what I actually did as the agent and my judgments.
  - **LIVE_POLICY_ENGINE** — the real hook scripts' outputs on those events.
  - **CLAUDE_CODE_HOOK_TRANSPORT** — simulated: the harness invokes the hooks with
    Claude-Code-shaped stdin instead of Claude Code doing it.

## Boundary mechanism chosen

**Byte-offset watermark + batch-as-opportunity** (not per-batch event attribution):

- The observer appends sanitized events to `events.jsonl` (unchanged).
- The batch hook consumes everything past a stored byte-offset watermark, then:
  - any **verification event** (test/build/device — failed runs count as collected
    evidence) resets the opportunity counter and clears the episode latch;
  - otherwise, any **non-test implementation event** consumed at this boundary makes this
    boundary ONE implementation opportunity (batch size irrelevant);
  - test-only events are neutral;
  - at **3 consecutive implementation opportunities** without verification: emit ONE
    factual `additionalContext` VERIFY_FIRST reminder (latched until the next
    verification).

**Why this is trustworthy (§2 answer):** no event is ever *assigned* to a batch, so the
async/sync race cannot misattribute. A late async event is consumed by the NEXT boundary —
worst case a warning moves one batch later, which is bounded; the watermark guarantees no
event is counted twice or skipped; concurrent observer appends can at worst corrupt one
line, which the parser skips (evidence loss reduces warnings — fail-safe direction).
Verified: watermark unchanged across empty boundaries; truncated final lines are not
consumed until complete; rotation/truncation resets cleanly.

## Experimental policy (behavior, §4)

"Count *repeated opportunities to verify* that the agent let pass, not raw edits." One
boundary that consumed 4 edits (impl + import fix + type fix + regression test) = ONE
opportunity. Three boundaries that each consumed edits with no verification event in
between = 3 opportunities → warn once.

## Claude dogfood tasks (CLAUDE_MODEL_BEHAVIOR)

Real work in three scratch projects, chosen before running, executed in order:

**Task B — productive debugging** (`taskB`, string utilities with 2 failing tests):
`node --test` FAIL (2) → edit slugify → `node --test` FAIL (1) → edit capitalize →
`node --test` PASS. Five batches. **LIVE_POLICY_ENGINE: silent throughout** (opportunity
counter never exceeded 1 — each failed run is collected evidence and resets it).

**Task C — legitimate multi-step refactor** (`taskC`, extract `formatDate` into
`lib/format.js`, migrate call sites, add a regression test):
C1 extract (impl) → C2 call-site 1 (impl) → C3 **smoke run `node app.js`** (I verified the
extraction before migrating) → C4 call-site 2 (impl) → **GOVERNOR FIRED** → C5 write
regression test (neutral, silent ✓) → C6 `node --test` PASS (reset ✓).

**Task A — genuine verification debt** (`taskA`, todo CLI, no test infrastructure —
verification deliberately deferred as "I'll test it later"): A1 write core → A2 done
toggle → A3 priority/timestamp fields → **GOVERNOR FIRED at A3** (3 distinct turns) →
**my natural reaction: I ran the module** (`add`/`done`/`list` round-trip) → it worked
first try → A4 further edit (latched, silent ✓) → A5 generic `node -e` verification run —
**not recognized** (same classifier gap as C3) → A6 wrote a regression test (neutral ✓) →
A7 `node --test` PASS (reset ✓).

## Actual intervention events and verdicts

| Warning | Where | CLAUDE_MODEL_BEHAVIOR verdict | Root cause |
| --- | --- | --- | --- |
| 1 | Task C, boundary C4 | **FALSE POSITIVE** — I had just verified via `node app.js`; the classifier does not recognize generic script/file execution as evidence | unrecognized verification form (same family as the fixed npm-script indirection) |
| 2 | Task A, boundary A3 | **INCONCLUSIVE** — trigger factually correct (3 unverified turns, no test infra existed); I ran the module and it passed, and the nudge produced a lasting regression test — but no defect was caught, so "useful" is not demonstrated | none (trigger correct); usefulness undecidable in this instance |

**Tally: 2 warnings — 0 USEFUL, 1 FALSE POSITIVE, 1 INCONCLUSIVE.**

## Productive workflows silent?

**YES** — Task B's fail→fix→fail→fix→pass loop (5 batches) never produced a warning; the
opportunity counter never exceeded 1 because each failed test run is collected evidence
that resets the counter.

## Legitimate multi-edit workflows silent?

**NO — this is the residual failure.** Task C fired at C4 because the mid-refactor smoke
run (`node app.js`) is invisible to the verification classifier. This is a systematic
class: **project-specific verification forms are unrecognizable without a project-level
contract** (declare "verification = `node app.js && node --test`" somewhere the governor
reads). The npm-script-indirection fix covered package-manager scripts only.

## Verification reset / anti-spam (LIVE_POLICY_ENGINE)

Verified live: verification (pass OR fail) resets the episode and clears the latch; the
warning fires exactly once per episode; a post-warning implementation batch stays silent;
a second debt episode after verification fires again once. Exactly-once semantics held.

## Attribution / concurrency findings (§2)

The watermark design resolves the async question structurally: no event→batch assignment
exists, late events are consumed at the next boundary (bounded one-batch delay), and the
byte-offset watermark prevents double-counting and loss-then-skip. Truncation/rotation
resets the watermark safely. Concurrent batch invocations serialize on a short lock with
stale-lock breaking. **Attribution is reliable for a conservative policy.**

One transport-layer caveat (CLAUDE_CODE_HOOK_TRANSPORT): concurrent observer appends can
in principle interleave lines; the parser skips corrupt lines, so the effect is rare
evidence loss (fewer warnings), never wrong evidence.

## events.jsonl growth (§10)

Dogfood scale: 16 events ≈ 4 KB total (~256 B/batch). Not a release blocker at this scale.
Smallest safe design if live ships: rotate at 5 MB to `events.1.jsonl` (keep one), reset
the watermark on rotation — proposed only.

## Corpus numbers (§11 — corrected classifier, current pipeline)

400 files scanned · 93 usable sessions · 441 attempts · 4,587 implementation calls ·
**588 verification events** (+~200 recovered by the npm-indirection fix) · 3 productive
windows · debt expressed in **distinct implementation turns** (windows of 3–26 turns
confirmed) · **0 dead-end windows** (the POC-04B one stands retracted). Token-window
numbers: excluded as unreliable.

## Hard success bar — verdict

| Requirement | Result |
| --- | --- |
| ≥1 genuinely useful VERIFY_FIRST | **NOT MET** (1 INCONCLUSIVE, 1 FP) |
| 0 false-positive warnings | **NOT MET** (1 FP: unrecognized verification form) |
| Productive debugging silent | MET |
| Legitimate multi-edit work silent | **PARTIAL** — silent only when a recognizable verification occurs mid-refactor; the C4 refactor fired |
| Exactly-once episode | MET |
| Verification reset | MET |
| Attribution survives concurrency | MET (watermark design) |
| Agent remains fail-open | MET |

**The gate is NOT passed → REPLAY-ONLY v0.1.**

## Strongest evidence FOR a live governor

The turn/batch watermark policy structurally fixed the dogfood's reported FP class
(multi-edit single-attempt), test-write neutrality works, reset/anti-spam work live, and
the remaining FP has a clear, implementable remedy (project verification contract:
`.agent-pigeon.json` declaring verification commands — which would have made C3's smoke
run recognizable and the warning disappear).

## Strongest evidence AGAINST

The only live usefulness instance was inconclusive (no defect found), while the FP class
that did appear (unrecognized verification) cannot be fixed conservatively without a
project-configuration contract that does not exist yet. A v0.1 that ships a live hook
whose main observable behavior is "occasionally nags during legitimate refactoring" risks
the install being removed — the exact outcome the dogfood gate exists to prevent. Replay
delivers the same core insight (28→re-validated debt windows in the wild) with zero
interruption risk.

## Remaining unknowns

- Whether a verification-contract file (`.agent-pigeon.json`) closes the unrecognized-
  verification FP class in practice (needs its own dogfood).
- Claude Code transport behavior (PostToolBatch exact stdin schema, per-event additional-
  context honor) — validated only against official docs.
- Outcome-identity mining needs a clean-output corpus (non-Windows Codex or Claude
  transcripts) before RETHINK can ever be reconsidered.

## v0.1 recommendation (exactly one)

**REPLAY-ONLY v0.1.**

- Ship: `agent-pigeon replay` (turn-aware, corrected classifier, turn-based debt report)
  + README/trust docs. This is validated, useful, zero-risk.
- The live governor (`init`/observer/batch hooks) moves to `experimental/` with a
  documented "requires verification-contract support + one clean dogfood" gate. All of its
  engineering (watermark policy, anti-spam, fail-open, race-safe secrets) is preserved and
  tested — dropping it from the *product surface* is not dropping the work.
- Retracted/unknown evidence (dead-ends, token burn per window, live behavior change)
  stays out of all product claims.

**STOP. No publish, no tag, no public repo change, no RETHINK. Awaiting user review.**
