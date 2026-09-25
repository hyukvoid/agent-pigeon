# POC-03.5 — Reality Gate — Findings

- Date: 2026-09-22
- Branch: `poc/035-reality-gate` (from POC-03 final commit `7de0b2d`)
- Closes four product risks: content novelty, three-concept separation, stronger dead-end/productive validation, Jev value test
- Environment notes: `TYPESAFE_API_KEY` / any Jev key: **NOT CONFIGURED** (checked by env-var name only; value never read). Claude Code quota still exhausted → live leg remains deferred.

## 1. Verdict: PASS

All 11 success criteria met (criteria 9–10 are conditional "if key exists" — the key does not exist, so they are recorded as explicitly NOT TESTED / UNJUDGED rather than failed). No HARD FAIL condition fired. Final verdict at §10.

## 2. changeFingerprint design (§1)

Problem: the event schema hashed edited **file paths**, so `LoginViewModel.kt` Patch A/B/C were indistinguishable — path identity is not code novelty.

New identity chain:

```
changeFingerprint = sha256( normalize(changePayload) )[0:8]
  normalize()     : collapse whitespace runs, trim (stability, not secrecy)
  changePayload   : Edit → [old_string, new_string]
                    Write → [content]
                    NotebookEdit → [new_source]
                    MultiEdit → aggregate of all (old, new) pairs
  fallback        : when no content is available → path-list hash, basis "path"
```

Implemented twice on purpose: `src/replay/fingerprint.ts` (transcript parser) and a mirrored copy inside the hook script (`hooks/hook-posttooluse.mjs`, a standalone .mjs that cannot import TS). A **mirror-contract test** drives the real hook and asserts its digest equals the TS implementation's for the same payload. The event carries `changeFingerprint` + `fingerprintBasis: 'content' | 'path'`; segmentation uses the fingerprint (path hash only as fallback).

**Privacy guarantees (hard, test-enforced):**
- Raw edit/source content is hashed in memory and immediately discarded — never written to events, fixtures, or Jev payloads.
- ~~The digest is one-way 8-hex; reconstruction is infeasible.~~ **CORRECTED in POC-03.5.1**: a 32-bit digest does not protect against reconstruction by candidate matching (guess content → compare digest). Fingerprints are now `HMAC-SHA256(perInstallSecret, canonicalPayload)`, stored as 128-bit / 32 hex — candidate matching requires this machine's secret. See [POC-04A.md](POC-04A.md), Part A.
- Test D writes a secret-bearing edit through the real hook and asserts the stored event contains none of the raw strings, only the digest and `"fingerprintBasis":"content"`.
- The Jev payload builder never receives change content (unchanged from POC-00 — it only ever sees counts/booleans/signature labels).

Fingerprint tests: A) same file + different edit → different ✓ B) same change re-applied (whitespace-run variants) → same ✓ C) different file + different edit → different ✓ D) no raw source in storage ✓. Documented limit: whitespace normalization collapses runs but does not equate `a + b` with `a+b` — formatting-insensitive, not AST-level. *(POC-03.5.1 supersedes the whitespace-run part: whitespace collapsing was REMOVED — indentation-sensitive changes now hash differently; only line-ending normalization remains. See POC-04A.md.)*

## 3. Three concepts (§2) — definitions as implemented

| Concept | Meaning | Source |
| --- | --- | --- |
| `runtimeChange` | Something observable changed on the latest pair. `NONE` (0 components) / `SINGLE` (1) / `MULTIPLE` (≥2 of: tests delta, crash change, screen change, build change) | deterministic pair signals |
| `evidenceGain` | The pair produced useful NEW diagnostic/runtime evidence. `HIGH` (≥2 new facts) / `MEDIUM` (1) / `LOW` (0) | deterministic pair signals |
| `goalProgress` | Evidence moved the app toward the **stated task objective**. `HIGH / MEDIUM / LOW / UNKNOWN` — evaluated ONLY against a ProgressContract; without one it is UNKNOWN by construction | `evaluateGoalProgress()` vs contract |

**Hard rule (enforced by fixtures + tests):** `screenChanged` or `crashChanged` alone never implies HIGH goalProgress. HIGH requires a contract-linked success signal: crash removed (observed), target screen reached, or — capped at MEDIUM — failing tests moving down. The old `runtimeProgress` field (which conflated change with progress) was removed from the model.

## 4. ProgressContract schema (§3)

```json
{
  "task": "Fix crash after Sign In",
  "crashMustDisappear": true,
  "targetScreenSignature": "Authenticated",
  "baselineScreenSignature": "Login",
  "testsMustDecrease": true,
  "usefulEvidenceSignals": ["failure moves deeper", "crash signature changes"],
  "noProgressSignals": ["same crash", "same screen", "same failed tests"]
}
```

Hand-authored declarative input (no LLM planning). Deterministic rules: success signals (crash removed / target reached / tests down) → HIGH (tests-only → MEDIUM); regression signals (baseline screen lost, crash appeared where none) → LOW with "movement without improvement" rationale; runtime moved but no success/regression fired → UNKNOWN (e.g. crash A→B still crashing); nothing moved → LOW. Matched `noProgressSignals` are reported alongside.

## 5. Reality fixtures A–E (`npm run poc:035`) — actual output

| CASE | runtimeChange | evidenceGain | goalProgress | debt | dead-end | policy |
| --- | --- | --- | --- | --- | --- | --- |
| A — Productive | MULTIPLE (tests −5; crash removed; screen changed) | HIGH | **HIGH** (crash disappears; target screen reached) | LOW | no | **OBSERVE** |
| B — New evidence, unclear progress | SINGLE (crash A→B) | MEDIUM | **UNKNOWN** (still crashing — goal impact unclear) | LOW | no | OBSERVE |
| C — Different implementation, same outcome | NONE | LOW | **LOW** (nothing changed) | LOW | **YES** | **RETHINK** |
| D — Verification debt | NONE | LOW | LOW | **HIGH** (streak 4) | no | **VERIFY_FIRST** |
| E — Wrong direction | MULTIPLE (new fatal crash; app left Login) | **HIGH** | **LOW** ("movement without improvement — app no longer reaches baseline screen (Login)") | LOW | no | OBSERVE |

Checks against spec: B does NOT report success despite `crashChanged=true` ✓ · E keeps `evidenceGain=HIGH` while `goalProgress=LOW` — movement ≠ improvement ✓ · C still triggers RETHINK with content fingerprints ✓ · A triggers no false warning ✓ · D stays fully deterministic, Jev not needed ✓.

## 6. Real history — expanded sample (§5)

Re-replayed with content fingerprints (Claude first):

- **8 sessions inspected** (one more than POC-02: the quota-failed `claude -p` attempt itself left an empty session file — no activity).
- The one usable session (`415efbff`) **re-confirmed under content fingerprints: all 11 edits have distinct content fingerprints (11/11, basis=content)** and the session still reconstructs as one unverified window → **Verification Debt HIGH — label manually re-verified as defensible** (the transcript contains 11 successive edits, 4 non-verification shell commands, and no build/test/device run anywhere).
- **Productive progression: NOT OBSERVED** in real history (no successful verification exists to compare).
- **Dead-end exploration: NOT OBSERVED** (no failed verification → no failure signature). Reported as NOT OBSERVED, not FAIL.
- **Codex (`~/.codex/sessions`) discovery:** 339 rollout JSONL sessions; sampled schema = `session_meta / event_msg / response_item / world_state / turn_context / token_usage_record` (payload+timestamp+type; the sampled file's response_items are message/reasoning only). Adapter remains deferred (Claude first); `token_usage_record` means real token accounting will be available when an adapter is built.
- Privacy: raw transcripts never entered git; only the regenerated sanitized derivative was committed.

## 7. Jev — real value test (§6–§7)

**NOT TESTED — `TYPESAFE_API_KEY` (and any Jev provider key) is not configured on this machine** (existence checked by name only). The minimum ambiguous-case test set (A: crash A→B unchanged tests/screen; B: slight improvement + regression elsewhere; C: new diagnostic evidence, unclear goal) is defined and wired for when a key exists: each maps to reality CASE B/E-shaped inputs, called at most once each, with the four independent axes (`evidence_gain`, `goal_progress`, `rethink_needed`, optional `human_needed`).

**Incremental-value verdict (§7): with no live evidence, Jev's value is UNJUDGED.** Decision applied now: Jev is **off the MVP critical path** (outcome C for the critical path) but kept as an optional/experimental provider interface (outcome B) — deterministic signals decide every fixture in this POC without any quality loss, and keeping Jev "because the project started around Jev" is explicitly rejected. A key-gated live test should run before Jev is either promoted or deleted.

## 8. CLAUDE LIVE / hook performance (§8–§9)

- **CLAUDE LIVE: DEFERRED_BY_ACCOUNT_ACCESS** (quota exhausted; no bypass attempted, no extra paid provider added).
- **Async hooks: CONFIRMED by official documentation** (code.claude.com/docs/en/hooks): command hooks support **`async: true`** — "runs in the background without blocking" — plus `asyncRewake` and `timeout` (with the caveat that `timeout` is not enforced on `async: true` commands). PostToolUse fires after the tool already ran; exit 2 is the only blocking exit code.
- Isolated benchmark configuration created: `<sandbox>/.claude/settings.async.json` (the production hook with `async: true`, not activated).
- Measured so far: (a) hook process wall-time p50 **101.0 ms** / p95 119.3 ms / max 134.4 ms (Node spawn-dominated; bare `node -e ""` baseline p50 ≈ 90.7 ms). (b) agent-visible blocking time: **≈ 0 with `async: true` per documented semantics** — the synchronous path blocks ≈ wall-time. Live in-agent delta remains unmeasurable without quota.
- **ASYNC LIVE IMPACT: UNVERIFIED** (live delta not measured). Consequence: the earlier "binary hook rewrite" recommendation is **withdrawn as unnecessary for now** — a config flag achieves non-blocking observation; a rewrite stays allowed only if live evidence later shows async dispatch overhead matters.

## 9. Unresolved risks

1. Jev value still unproven (key-gated); the semantic layer remains dormant by design until tested on genuinely ambiguous cases.
2. Real-history sample for productive/dead-end remains thin (1 usable Claude session; Codex adapter deferred).
3. `async: true` drops Claude Code's `timeout` enforcement — a hung observer process could linger; acceptable for an append-only writer but worth a supervisor later.
4. Content fingerprint is whitespace-normalized only (not AST-level): formatting-only refactors count as novel. Conservative direction (more RETHINK risk, not false progress), acceptable for now.
5. Agent-visible async overhead (dispatch/scheduling per tool call) is UNVERIFIED until a live session runs.

## 10. Final verdict

**GO → POC-04** — with preconditions unchanged and sharpened: (1) obtain a Jev key and run the defined ambiguous-case test set before POC-04 ships any semantic surface; (2) activate `async: true` in the live configuration and measure the real in-agent delta when quota returns.

**No nudge, no context injection, no Stop blocking, no notification, no PigeonHub, no dashboard, no iOS, no Codex live, no binary hook rewrite.**
