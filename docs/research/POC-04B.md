# POC-04B — Real Corpus Gate — Findings

> **⚠ CORRECTED BY POC-04C**: the "1 confirmed dead-end (MEDIUM)" below was later shown to be a **FALSE POSITIVE** caused by failure-signature coarseness (the signature hashed harness wrapper lines — "Script failed / Wall time N seconds / Output:" — which are identical for every failed command in every project). After the signature was rebuilt (wrapper-filter + last-3-content-lines, POC-04C), dead-end candidates in this corpus dropped to **NOT OBSERVED**, and the debt/productive findings were re-validated. See [POC-04C.md](POC-04C.md). The debt findings below remain valid.

- Date: 2026-09-22
- Branch: `poc/04b-real-corpus-gate` (from POC-04A.1 final commit `05a8973`)
- Sources (READ-ONLY): `~/.codex/sessions` (340 rollout files, 1.2 GB, 178,945 lines) + `~/.claude/projects` (10 files)
- Final regression: **71/71 tests pass**

## 1. Verdict: PARTIAL → recommendation **HOLD (collect more real data)**

> Do real coding-agent sessions contain the kind of "different implementation, same outcome" behavior that would justify a RETHINK governor?

**Yes — one real, manually CONFIRMED dead-end window exists** (Codex session `019e835d`: 2 materially different patches — 32 and 47 implementation calls — verified with build FAIL then test FAIL, identical normalized failure signature `7650e978`). The detector found it; the manual audit confirmed the label is defensible.

However, the RETHINK gate (§9) is **not fully satisfied**: a real PRODUCTIVE window does not exist in this corpus, so "the detector can distinguish a dead-end from a real productive window" could only be demonstrated synthetically, not against real data. Precision-over-recall was held (0 false positives), and per §9 RETHINK therefore **remains disabled**.

## 2. Corpus coverage (§8)

| Metric | Value |
| --- | --- |
| Files scanned (codex + claude) | **350** (340 codex + 10 claude) |
| Parsed sessions | 350 (0 parse errors) |
| Sessions with tool activity | 52 |
| **Usable sessions (attempts reconstructed)** | **9** |
| Sessions with verification activity | 49 (mostly verification-only: no implementation → no attempts) |
| Sessions that appear mobile/Android | 3 (flagged by command signals: adb/gradle/emulator/logcat/apk/android) |
| Implementation attempts reconstructed | 14 |
| Implementation calls (sanitized) | 581 |
| Verification events (sanitized) | 26 |

**MOBILE vs GENERAL (§5):** 3 sessions were mobile-flagged, but **none produced candidates** → mobile-specific confirmed examples: **NOT OBSERVED** (reported honestly). All confirmed findings below are GENERAL CODING. Per spec, they validate the temporal detector but do not prove the mobile thesis.

## 3. Codex adapter findings (§2)

- Main tool channel: `response_item/custom_tool_call` — **`exec` (18,785 calls, input = plain command string)** and **`apply_patch` (570 calls, input = `*** Begin Patch` unified patch text)**.
- `apply_patch` parsing: `*** Update/Add/Delete File:` sections give per-call changed-file counts + path hashes; the **patch body itself is the change content** → `changeFingerprint = HMAC-SHA256(secret, {op:'patch', parts:[patch]})` (128-bit, per-install secret — same hardening as POC-04A.1). Materially different patches → different fingerprints; re-applied identical patches → same fingerprint.
- Output pairing via `call_id`: **100% of sampled outputs matched their calls** (4,713/4,713). Output = array of `{text,type}` elements; text union yields exit code (`exit code: N`), failed-test counts (numbers only) and failure-signature hashes (normalized first-error-line HMAC, 8-hex).
- `function_call/shell_command` (2,091): arguments = `{command, timeout_ms, workdir, …}`; command joined and classified with the shared conservative classifier.
- Verification classification stayed conservative: build/test/device patterns only; arbitrary `exec` commands are 'other'.
- **Tokens (§11):** `token_usage_record.thread_token_usage` is CUMULATIVE with record timestamps → per-window deltas are reconstructible (machinery proven on the synthetic fixture: 140 → +250). For the real candidate windows: **UNKNOWN** (no token records overlap those attempts). Token counts never influence labels.

## 4. Findings (§4, §6 — with manual audit)

### A. PRODUCTIVE: NOT OBSERVED

Zero real productive windows. The corpus's verification events either never followed implementations or never showed a failure→success transition. Reported honestly; not manufactured.

### B. VERIFICATION DEBT: 4 candidates → 4 CONFIRMED (all HIGH)

| Candidate | Source | Shape | Audit |
| --- | --- | --- | --- |
| `019e6e63` | codex | 1 window, **62 implementation calls, 0 verifications** | **CONFIRMED** |
| `019f324c` | codex | 1 window, **23 implementation calls, 0 verifications** | **CONFIRMED** |
| `019f99b7` | codex | window after a build:FAIL attempt, **28 implementation calls, no verification** | **CONFIRMED** |
| `415efbff` | claude | 11 edits, 0 verifications (POC-02 reconfirmed) | **CONFIRMED** |

All four are exactly the pattern VERIFY_FIRST targets and are already covered by the existing governor.

### C. DEAD-END EXPLORATION: 1 candidate → **CONFIRMED** (MEDIUM)

Candidate `019e835d` (codex, sanitized audit trail):

```
attempt 1  impl=32  fingerprint caae66bb…  verification: build:FAIL  failuresig 7650e978
attempt 2  impl=47  fingerprint a37da8c1…  verification: test:FAIL   failuresig 7650e978   (SAME)
attempt 3  impl=41  fingerprint d6d80a5f…  verification: test:pass ×2                      (RESOLVED)
```

Manual audit: two materially different patches (32 vs 47 implementation calls, distinct content fingerprints), each verified, producing the **same normalized failure signature** — "different implementation, same outcome" is defensible at attempt 2; attempt 3 later resolved it, which is exactly the shape of a well-timed RETHINK nudge. Verdict: **CONFIRMED**.
Caveats recorded honestly: only 2 attempts in the run (MEDIUM confidence, below the ≥3 HIGH bar), and attempts 1→2 span a ~16-day session resume — cross-resume episode identity is a known fuzziness.

**False positives: 0.** **Inconclusive candidates: 0** (all three found candidates were audited; everything else was silence).

## 8. Metrics summary (§8)

| Metric | Value |
| --- | --- |
| Candidate productive windows | 0 → confirmed 0 |
| Candidate verification-debt windows | 4 → confirmed 4 |
| Candidate dead-end windows | 1 → confirmed 1 (MEDIUM) |
| False positives | 0 |
| Inconclusive candidates | 0 |
| Mobile-specific confirmed examples | 0 (NOT OBSERVED) |
| Token data for candidates | UNKNOWN (records do not overlap windows; reconstruction machinery proven on synthetic fixture) |

## 9. RETHINK gate (§9)

- ≥1 real confirmed dead-end: **YES** (1, MEDIUM).
- Distinguishable from a REAL productive window: **NOT DEMONSTRABLE** — no real productive window exists in this corpus (discrimination is only synthetic-proven).
- Outcome-based (not activity-based) distinction: **YES** by construction (failure-signature identity + repeated verification; token/activity volume never inputs).

→ **RETHINK remains disabled.** The gate requires stronger real evidence.

## 10. Jev (§10)

Not configured → nothing done. No key was obtained or exposed.

## 11. Demo-worthy (§12)

- Dead-end candidate `019e835d`: **DEMO-WORTHY: NO** — only 2 attempts; a sanitized README demo needs a ≥3-attempt "Tests 8 → 8 → 8, failure UNCHANGED" shape.
- Side note: the debt windows (e.g. "62 implementation calls · 0 verification runs") are demo-worthy for VERIFY_FIRST, which already ships.

## 12. Privacy treatment

Raw transcripts (Codex rollouts, Claude sessions) were read in memory only and never entered git. The only committed corpus artifacts are: a **synthetic** Codex fixture (`fixtures/codex/sample-rollout.jsonl`) and the **sanitized candidates file** (`fixtures/corpus/candidates.json`) containing hashes, counts, booleans and ranges only — privacy-checked in the run. Survey/audit scripts print aggregates exclusively.

## 13. Process incident (recorded)

At POC-04B start, HEAD had been externally moved to `main` (bootstrap) and a `poc/04b-real-corpus` branch created there, which reset the working tree. All POC work was intact on `poc/04a1-live-delivery`; recovery was: delete my accidentally created empty pointer branch, re-branch from `poc/04a1-live-delivery`. The external branches (`main`, `poc/04b-real-corpus`, `poc/04a1-delivery-concurrency`) were left untouched.

## 14. Recommendation

**HOLD → collect more real data.** The corpus proves debt detection on real history and yields one confirmed real dead-end, but contains zero real productive windows and zero mobile-specific candidates — insufficient to (a) satisfy the RETHINK gate's discrimination clause against real productive data, or (b) demonstrate mobile value. Concrete collection targets: sessions with repeated verification runs (the current corpus is dominated by zero-verification agent runs), ideally mobile/Android sessions using gradle/adb/agent-device. RETHINK stays disabled until ≥1 more confirmed dead-end AND ≥1 real productive window exist to prove discrimination.

**STOP. RETHINK not implemented. Awaiting user review.**
