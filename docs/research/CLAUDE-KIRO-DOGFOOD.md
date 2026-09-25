# Claude-in-Kiro Behavioral Dogfood — VERIFY_FIRST

- Date: 2026-09-23
- Validates: **CLAUDE_MODEL_BEHAVIOR_IN_KIRO**
- Does NOT validate: **CLAUDE_CODE_HOOK_TRANSPORT**
- Repo state at end: **84/84 tests pass** (was 77), 7 source/test files modified

## Method, and what is real vs simulated

I worked as a normal coding agent in this repository and did not aim for any
particular edit count or outcome. Three real tasks, chosen after reading the
code, each landing a real defect fix.

- **Real:** the observer hook (`hooks/hook-posttooluse.mjs`) and the governor
  (`dist/src/governor-batch.js` → `src/governor/governor.ts`). Every "would it
  fire?" claim below was produced by feeding my actual tool sequence through
  those two shipped scripts and reading their actual stdout, not by reasoning
  about the regex.
- **Simulated:** delivery. Kiro's edit tools are `str_replace` / `fs_write` /
  `fs_append`, and the hook's `IMPLEMENTATION_TOOLS` set is Claude Code's
  `Edit|Write|MultiEdit|NotebookEdit`. I mapped mine onto those names 1:1 and,
  at each point where the real governor emitted `additionalContext`, I pasted
  the exact message into my own context and continued working.
- **Not tested:** whether Claude Code actually delivers the hook payload. No
  `claude` CLI or Claude Code binary was invoked.

One caveat on ordering: `PostToolBatch` fires once per *batch*, and I drove it
after *every* tool call. That is the governor's most trigger-happy possible
schedule. A real batch containing several edits would fire at the batch
boundary instead, which shifts *when* a warning lands but not *whether* the
episodes below qualify.

## Tasks attempted

| # | Task | Result |
| --- | --- | --- |
| 1 | `replay` reported `Scanned N` from successfully-parsed files only; `countUnreadable()` was a stub returning 0, so unreadable history was silently dropped | fixed; `scanSessions()` extracted to `corpus.ts`, 2 regression tests |
| 2 | A leftover `governor-batch.lock` from a killed process permanently silenced the governor **and** added ~1.7 s to every synchronous pre-model hook call | fixed (stale-lock recovery), 2 tests (one reproduced the bug first) |
| 3 | The live hook and the replay parser duplicate the verification patterns and had silently drifted; neither recognized package-manager script indirection | both reconciled, script indirection added, hook↔TS parity test added |

## Natural behavior observed, and where VERIFY_FIRST fired

Verified output from the real hook + real governor (`>>` = emitted):

```
=== ep1: replay "Scanned" count bug ===
 1.    silent        cli.ts  count considered files, add unreadable
 2.    silent        cli.ts  print the Unreadable line
 3. >> VERIFY_FIRST  cli.ts  delete the dead countUnreadable stub
 4.    silent        npm run typecheck        <- real verification
 5.    silent        corpus.ts  extract scanSessions (testability)
 6.    silent        cli.ts  call scanSessions
 7. >> VERIFY_FIRST  cli.ts  update the import
 8.    silent        replay.test.ts  add the regression test
 9.    silent        replay.test.ts  import scanSessions
10.    silent        npm test  -> 79 pass

=== ep2: stale-lock bug (productive loop) ===
 1.    silent        governor.test.ts  add failing tests I and I2
 2.    silent        governor.test.ts  import utimesSync
 3.    silent        npm test  -> 1 FAILED (bug reproduced)
 4.    silent        governor-batch.ts  add LOCK_STALE_MS
 5.    silent        governor-batch.ts  add breakIfStale + call it
 6. >> VERIFY_FIRST  governor-batch.ts  import statSync
 7.    silent        npm test  -> 81 pass

=== ep3: mirrored classifier change ===
 1.    silent        claude.ts  script-indirection patterns
 2.    silent        hook-posttooluse.mjs  mirror the patterns
 3. >> VERIFY_FIRST  replay.test.ts  classification assertions
 4.    silent        governor.test.ts  hook/TS parity test
 5.    silent        governor.test.ts  import classifyVerificationCommand
 6.    silent        npm test  -> 84 pass

=== control: 3 edits to ONE test file, zero production code ===
 3. >> VERIFY_FIRST  test/a.test.ts  add case 3

=== control: scaffolding 3 new files (nothing runnable yet) ===
 3. >> VERIFY_FIRST  Write src/new/b.ts
 4.    silent        npm test
```

Six warnings across three real tasks and two controls.

## Useful warnings

**None.** Not one warning surfaced a defect, changed a decision, or caught a
change I was not about to verify anyway. In every episode verification arrived
within one or two tool calls of the warning, and it was already the next thing
on my list.

For the record, the three defects I did find came from reading code and from
targeted probes, not from any warning.

## False and annoying warnings

| # | Where | Verdict | Why |
| --- | --- | --- | --- |
| 1 | ep1 edit 3 — deleting a dead stub | **ANNOYING** | Three edits, one function, one file, one logical change. I complied and ran `npm run typecheck`: it passed and told me nothing. Worse, at the time `npm run typecheck` classified as `other`, so my compliance did not even clear the debt. |
| 2 | ep1 edit 7 — adding an import | **FALSE POSITIVE** | Mid-extraction. The three "distinct changes" were *add function / call it / fix the import* — one refactor, counted as three. |
| 3 | ep2 edit 6 — adding an import | **FALSE POSITIVE** | I had *already* run a failing test to reproduce the bug, and ran the suite one call later. This is the textbook productive loop, and it warned anyway. |
| 4 | ep3 edit 3 — test assertions | **ANNOYING**, arguably harmful | The change's whole point was hook↔TS mirror parity. Complying would have run a green suite that contained no parity coverage — partial verification that *looks* like proof. I declined it. |
| 5 | control — 3 edits to one test file | **FALSE POSITIVE** | Writing tests is counted as implementation debt. Authoring verification is treated as evidence of *not* verifying. |
| 6 | control — scaffolding 3 new files | **FALSE POSITIVE** | Nothing existed to run yet. |

**Precision: 0 of 6.** Four false positives, two annoying, zero useful.

Two structural causes, both confirmed in code:

1. **Test-file edits count as implementation debt.** `IMPLEMENTATION_TOOLS`
   is matched on tool name with no path awareness, so a `Write` to
   `test/foo.test.ts` is indistinguishable from a `Write` to `src/`.
   Warning 5 is entirely explained by this, and warnings 3 and 4 partly.
2. **One logical change is many tool calls.** Warnings 2, 3 and 6 all fired on
   the *mechanical last edit* — an import line, a third scaffold file — i.e.
   exactly when the change first became verifiable. The trigger counts change
   *volume*; it cannot see that a fix is not yet compilable.

Also worth noting: `POC-04A.md` §E and scenario H claim "productive workflows
remain silent." That guarantee holds only when each fix is a single tool call.
Warning 3 is a real productive loop that warns, so the claim is narrower than
stated.

## Where Agent Pigeon correctly stayed silent

- ep2 steps 1–3: two edits then a failing test run → silent. Correct, and the
  failed run correctly counted as evidence collected.
- After every warning, further edits in the same episode stayed silent. The
  anti-spam latch works exactly as documented; I could not make it double-fire
  within one episode.
- ep3 steps 4–5: silent after firing, no verification in between. Latch held.
- The repo's own unit tests (50 identical edits, tool-call counts, elapsed
  time) are genuine non-triggers, and I found nothing that contradicts them.

One apparent double-fire in ep1 (steps 3 and 7) is **not** a latch bug: my own
classifier fix made `npm run typecheck` count as verification, which reset the
debt and legitimately opened a second episode. That is a real second-order
effect worth stating plainly: **widening what counts as verification does not
monotonically reduce warnings** — it resets the latch more often, so a long
loosely-verified stretch can produce *more* warnings, not fewer.

## Evidence quality: the trigger's blind spot, quantified

VERIFY_FIRST fires on *absence of evidence*, so it is only as good as its
evidence detector. Measured against my real local history (393 sessions), with
only the build artifact swapped so source stayed untouched:

| | verification runs | debt windows | productive loops |
| --- | --- | --- | --- |
| before | 428 | 28 | 2 |
| after | **588** | **27** | **3** |

**160 real verification runs — 27% of the true total — were invisible**, because
the classifier matched underlying tools (`tsc`, `jest`) and not the scripts
repositories actually run. This project's own fast check, `npm run typecheck`,
was classified `other`. The live governor shares this classifier, so the same
27% blind spot was feeding the live trigger. It also means the `28 debt windows`
headline was computed with the blind classifier and needs a
re-baseline (one of those 28 was a false positive; one real productive loop was
missed).

## Two live-path defects found while probing

- **Stale lock (fixed).** A `governor-batch.lock` left by a killed process was
  never reclaimed. Measured: clean run 192 ms → stale-lock run 1759 ms, silent,
  repeatable, lock still present afterwards. The source comment claiming stale
  locks "expire via the timeout path" was wrong; the timeout only gives up. So
  the failure mode was a permanently-disabled governor plus a ~1.7 s tax on
  every model call, with no symptom a user would attribute to Agent Pigeon.
- **Unbounded events file (not fixed).** `readEvents` reads all of
  `events.jsonl` on the synchronous pre-model path, and nothing rotates it.
  Measured median `PostToolBatch` latency: 245 ms at 0 events → 313 ms at 50 k →
  **571 ms at 200 k**. At a few hundred tool calls a day, 200 k is well under a
  year of use. Monotonic, silent, and directly in the agent's hot path.

## Strongest argument FOR live VERIFY_FIRST

The phenomenon is real and the delivery is genuinely safe. Replay found 27
verification-debt windows in my actual history — these are not hypothetical.
The mechanism is about as unobtrusive as an intervention can be: non-blocking,
fail-open (I confirmed corrupt state and contended locks produce silence and
exit 0), once per episode, no network, no source content, ~200 ms. The cost of
a wrong warning is one short paragraph of context; I complied twice and it cost
about 15 seconds total. On that arithmetic, even weak precision could pay for
itself if it ever caught a real unverified change — and a warning arriving
*during* work is worth more than the same finding in a report read next week.

## Strongest argument AGAINST live VERIFY_FIRST

Precision was 0 of 6 in a session that produced three real bug fixes and seven
new tests — the exact profile of a developer this tool should approve of. The
warnings did not fail randomly; they failed *systematically*, on the last
mechanical edit of a change that was one tool call from being tested, and on
edits to test files. So the failures scale with the size of legitimate work:
the bigger and more careful the refactor, the more certain the warning.

The real damage is not the 15 seconds. It is that by episode 3 I had learned to
ignore it, and consciously declined it — correctly, because complying would
have run a green suite with no parity coverage and produced a *false* proof.
A trigger that is wrong most of the time trains the agent to discard it, which
destroys its value for the one case it exists to catch. And precision was
being computed on top of an evidence detector that was missing 27% of real
verification runs, so the trigger's own denominator was unsound.

## Challenge to the current policy

`3 distinct changes + no verification` is too crude. It measures change volume
and treats absence-of-evidence as if it were evidence-of-absence. Two pieces of
evidence should qualify it, both directly supported by this session:

1. **Turn/batch persistence instead of edit count.** All six false positives
   had verification within one or two tool calls. Warn only if the debt
   survives a *second consecutive batch* in which no command of any kind ran.
   That is implementable in the existing `PostToolBatch` state (the latch file
   already persists) and would have suppressed at least four of six.
2. **Path-aware change classification.** Edits under a test directory should be
   neutral, not debt. This alone removes warning 5 and softens 3 and 4.

Weaker, still worth it: don't count an edit that only adds an import or
otherwise cannot change behavior on its own; and fix the message wording —
"Verify the current **app**" reads wrong in a CLI/library repo.

I would not add time, token or tool-count inputs. The repo is right to exclude
them, and nothing I saw argues otherwise.

## Changes I made to the repository

Dogfooding produced real fixes; all are covered by tests and the suite is green
(77 → 84 tests). Nothing was published, tagged, or pushed.

- `src/cli.ts`, `src/replay/corpus.ts` — honest `Scanned` accounting,
  `scanSessions()` extracted
- `src/governor-batch.ts` — stale-lock recovery (`LOCK_STALE_MS`, `breakIfStale`)
- `src/replay/claude.ts`, `hooks/hook-posttooluse.mjs` — script indirection,
  drift between the two copies reconciled
- `test/replay.test.ts`, `test/governor.test.ts` — 7 new tests, including the
  first hook↔TS classifier parity test

Unrelated hygiene note: `test/live-observe.test.ts` leaks its temp directories
(132 `pigeon-live-*` dirs left in `%TEMP%` on this machine). Not touched.

## Recommended next step

Do not ship the live governor in v0.1 on this trigger, and do not run more
dogfood on it either — more sessions will reproduce the same systematic false
positives, not new information. Make the two qualifications above (batch
persistence, path-aware classification), then re-run exactly the five episodes
in this report as a fixture-backed regression: the target is 0 of 6 firing.

Separately and independently, re-baseline the v0.1-RC-era replay numbers
against the fixed classifier. Replay is the stronger half of this product and
its headline figures just moved.

---

## Final verdict

**REVISE VERIFY_FIRST**
