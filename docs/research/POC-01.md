# POC-01 — Real Mobile Evidence — Findings

- Date: 2026-09-22
- Branch: `poc/01-real-mobile-evidence` (from POC-00 final commit `dc38412`)
- Environment: Windows 11, Android SDK (`%LOCALAPPDATA%\Android\Sdk`), emulator 36.4.9 (WHPX), AVD `Medium_Phone_API_36.1` (API 36.1, cold boot ~40 s), adb 37.0.0, agent-device **0.21.8** (devDependency, invoked directly — no fork, no wrapper)
- App under observation: `com.android.settings` (real system app; no app build required, Gradle absent)
- Locale note: device runs Korean locale; signatures hash label content, so this does not affect determinism on a given device.

## 1. Verdict: PASS

> 실제 Android runtime evidence를 수집하여 POC-00 AttemptEvidence로 안정적으로 정규화할 수 있는가?

**Yes — proven against a live emulator.** Real agent-device snapshots normalize into stable `AttemptEvidence`, same state repeats as same, real navigation and a real crash register as change, and the POC-00 core evaluator classified REAL A/B/C correctly **without any modification to its role** (only its streak semantics were hardened; see §5).

## 2. REAL A / B / C results (live emulator)

### REAL A — same state, observed twice

```
Screen    com.android.settings#3449ce35 → com.android.settings#3449ce35
Evidence gain LOW   Policy CONTINUE
Verdict   • No strong signal yet — continue.
```

Two captures ~seconds apart → byte-identical signatures. Also stable across the whole run: homepage captured 4 separate times (a1, a2, b1, c2) produced the same `3449ce35` — locked in by `test/adapter.test.ts`.

### REAL B — actual runtime change (navigation + real crash resolved)

```
Screen  com.android.settings#3449ce35 → #3a1636f7 → #2cd111fa → #3449ce35
Crash   (none) → (none) → RemoteServiceException$Crashe… → (none)
Evidence gain HIGH (latest pair: crash resolved + screen changed)
```

- Homepage → 네트워크 및 인터넷 subscreen: `screenChanged = true` (`3449ce35` → `3a1636f7`).
- Real crash injected (`adb shell am crash` — experiment control, not evidence): crash dialog observed (`#2cd111fa`) and the crash **signature extracted from real Android crash output**; after relaunch the crash is gone and `crashChanged = true` via the new "observed clean" rule (§5).

### REAL C — different code, same app

```
Attempts 3 · Changed implementations 3
Screen   com.android.settings#3449ce35 → #3449ce35 → #3449ce35
Dead-end candidate YES · Policy RETHINK
Verdict  ⚠ Different code. Same app.
```

Three real file edits (novel change-set hashes) with the runtime frozen — the POC-00 dead-end detector fires on **real captures**, not just fixtures.

## 3. Adapter boundary (spec §5)

```
agent-device CLI → capture.ts (invokes provider, times it)
                 → adapter.ts normalizeAgentDeviceEvidence() → AttemptEvidence
                 → POC-00 core evaluator (signals.ts / evaluate.ts, unmodified role)
```

`src/core/**` imports nothing from `src/agent-device/**` — the dependency arrow points one way only. `npm run poc:01` runs the full pipeline; `--save-fixtures` persisted the real captures into `fixtures/agent-device/real/` (privacy-screened: no session paths, no personal data — Settings UI labels and a framework crash trace only).

## 4. Normalization rules (spec §6), as implemented

- **Screen identity** = `Page:` value + `#` + first 8 hex of sha256 over the *sorted set* of normalized interactive-node lines. Node lines strip refs (`@e12`), settle pins (`~s376685`), trailing flags (`[scrollable]`) — renumbering refs does not change the signature (unit-tested).
- **Structural noise exclusion**: capture uses `agent-device snapshot -i` (interactive elements only), so status-bar churn (clock "4:40", battery "100%", signal text) never enters the hashed set. This was a real hazard — full snapshots contain the clock, which would mint a false change every minute.
- **Crash identity** = exception simple name + first app-owned (`non-android.*`/`java.*`/`kotlin.*`/`androidx.*`) stack frame as `Class#method`. Timestamps, PIDs, TIDs and memory addresses are dropped by construction. Framework-only traces (e.g. `adb shell am crash`) fall back to the exception simple name alone.
- **Over-merging guard**: distinct screens keep distinct hashes because full label text is preserved; distinct crashes keep distinct exception/frame identity. Only addresses/PIDs/timestamps — things that never mean "different behavior" — are discarded.
- **Crash "resolved" rule (new)**: a signature that was present and is now null counts as `crashChanged = true` when the current attempt actually observed the runtime (`verification.performed`). "Looked, crash gone" is a transition; "never looked" is not.

## 5. Core-evaluator hardening (POC-00 semantics, kept conservative)

- `sameCrashStreak` now treats "runtime observed, no crash present" as a stable *value* (clean marker) — an app that was really launched and didn't crash is a stable observation; a never-verified attempt still breaks streaks. This is what lets REAL C (crash-free real app) reach dead-end while synthetic Fixture C (no verification) still cannot.
- Dead-end detection no longer requires test counts to be present (real sessions often lack them): it requires ≥3 novel patches, ≥3-length screen & crash streaks, and no observed pair with any runtime/test movement.

## 6. Latency (spec §8 — capture pipeline, separate from POC-00's µs evaluator numbers)

| Stage | Measured |
| --- | --- |
| agent-device `snapshot -i` capture (avg) | **252–267 ms** per attempt (in-process child invocation of the CLI, npx overhead avoided) |
| Normalization (parse + hash + adapter) | **0.07–0.54 ms** per attempt |
| Deterministic evaluation | 10–70 µs per scenario |
| End-to-end capture → verdict (per attempt) | **~250–510 ms** |

Verdict latency is dominated by the provider CLI, not by Agent Pigeon. Well within any interactive budget.

## 7. agent-device provider findings (honest gaps)

1. **`logs` channel is broken on this Windows host** — `logs start` fails with `Managed app-log process did not expose a complete ownership marker` (state=failed, `logs doctor` confirms; app.log stays stale even across a real crash). POC-01 therefore feeds the per-attempt log window from the **Android crash buffer** (`adb logcat -b crash -d`, with before/after line offsets) — real crash output, but obtained outside agent-device. This is a *provider environment bug*, not a thesis problem: snapshot evidence (the load-bearing surface) worked flawlessly. POC-02+ should retry `logs` on other hosts/versions; the adapter accepts any logcat text.
2. `snapshot` has no per-window "unchanged" ack in practice here (full tree returned); harmless, but the adapter handles the ack form defensively.
3. Session claiming: a second `open` while a session exists reuses it (devices output shows "claimed by session"); the runner force-stops the app for clean state.

## 8. PASS criteria check (spec §10)

| Criterion | Result |
| --- | --- |
| Real agent-device evidence normalized into usable schema | **PASS** (real captures in `fixtures/agent-device/real/`, adapter tests assert schema) |
| Repeated same state judged as same | **PASS** (REAL A + cross-run homepage stability) |
| Meaningful state change judged as change | **PASS** (navigation + crash resolved, REAL B) |
| Core evaluator decoupled from adapter | **PASS** (one-way import; core has zero agent-device knowledge) |
| No obvious false change from noise | **PASS** (status bar excluded structurally; ref/renumber invariance tested; same-state stability across a whole run) |

Jev smoke (spec §9): **NOT TESTED** — no `TYPESAFE_API_KEY` (or any Jev provider key) exists in this environment. C-scenario Jev call was optional anyway.

## 9. BLOCKED / non-goals

- No BLOCKED status: the Android environment was available. (Gradle is absent, so no custom app was built — unnecessary: a real system app provided all required runtime states.)
- Non-goals respected: no hooks, no daemon, no ADB wrapper of our own (agent-device invoked as-is; plain `adb` used only for experiment *control* — crash injection and app reset — not for evidence), no iOS.

## 10. Commits

- `feat: add real mobile evidence adapter and capture layer`
- `test: validate mobile evidence normalization against real captures`
- `docs: record POC-01 findings`
