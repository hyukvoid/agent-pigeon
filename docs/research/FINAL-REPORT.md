# Agent Pigeon POC-01~03 Report

- Date: 2026-09-22
- Scope: POC-01 (real mobile evidence) → POC-02 (real session replay) → POC-03 (live Claude observation)
- Environment: Windows 11, Node 24.19, TypeScript 5.9.3, zero runtime deps, agent-device 0.21.8, Claude Code 2.1.88, Android emulator API 36.1
- Full per-POC details: [POC-01.md](POC-01.md) · [POC-02.md](POC-02.md) · [POC-03.md](POC-03.md) · [POC-00.md](POC-00.md)

## Executive Verdict

| POC | Verdict |
| --- | --- |
| POC-01 — Real mobile evidence | **PASS** |
| POC-02 — Real session replay (product kill gate) | **PASS** |
| POC-03 — Live Claude observation | **BLOCKED (live leg: Claude 계정 월간 크레딧 소진 402)** — hook·worker 파이프라인은 실증 완료 |

POC-03의 BLOCKED는 환경 제약이지 가설 실패가 아님 (지시문 기준). HARD FAIL 없음 → POC-04 금지 조건 미발동.

## Product Thesis

> "Agent Pigeon can determine whether a mobile coding agent is producing real proof of progress rather than merely changing code."

**현재 증거 범위에서 성립.** 세 계층이 각각 실증됐다:

1. **Runtime 계층 (POC-01)**: 실제 에뮬레이터에서 동일 상태는 동일 서명(4회 반복 관측에서 `#3449ce35` 불변), 실제 화면 전환·실제 크래시 소멸은 변화로 판정, 3개의 다른 패치 + 얼어붙은 runtime → "⚠ Different code. Same app." — 전부 실측.
2. **History 계층 (POC-02)**: 실제 세션에서 11회 코드 수정 + 검증 0회 = HIGH-confidence Verification Debt 발견. 사람이 transcript를 직접 읽었을 때와 동일한 결론. False positive 0.
3. **Live 계층 (POC-03)**: hot path에서 어떤 무거운 작업도 하지 않는 hook이 정규화된 이벤트만 남기고, offline worker가 µs 비용으로 attempt timeline을 재구성함을 실증 (live agent 연결만 미검증).

## POC-01

- **Environment**: Android SDK + emulator 36.4.9 (WHPX) + AVD `Medium_Phone_API_36.1`, cold boot ~40 s. 좀비 qemu 프로세스가 AVD 락을 점유해 첫 부팅이 10분+ offline으로 멈췄던 문제는 프로세스 정리로 해결.
- **Actual agent-device evidence**: `snapshot -i` (평균 252–267 ms/capture) — 실측 출력을 그대로 fixture로 커밋 (`fixtures/agent-device/real/`, 프라이버시 스크리닝 통과).
- **Normalized evidence**: `normalizeAgentDeviceEvidence()` — adapter만이 agent-device 방언을 알고, core evaluator는 전혀 모름 (단방향 의존 검증).
- **Real A/B/C**: A = 동일 상태 2회 → 서명 동일, gain LOW · B = 네비게이션 `#3449ce35→#3a1636f7` + 실제 크래시(`RemoteServiceException$CrashedByAdbException`) 발생→소멸 감지, gain HIGH · C = 신규 패치 3개 + 얼어붙은 화면 → dead-end YES, RETHINK, "⚠ Different code. Same app.".
- **Normalization problems**: 상태바 시계/배터리 노이즈는 `-i` 캡처로 구조적 제거; ref 번호·settle pin은 해시 전 제거 (재번호 불변 테스트); 프레임워크 전용 크래시 trace는 예외 simple-name fallback.
- **False changes**: 없음 — 같은 홈 화면 4회 캡처가 모두 동일 서명.
- **Latency**: capture ~260 ms (provider CLI가 병목), normalize 0.07–0.54 ms, deterministic eval 10–70 µs.
- **Jev smoke**: 미실행 (환경에 키 없음 — 아래 Jev 섹션).

## POC-02

- **Sessions inspected**: 7 (`~/.claude/projects`, 읽기 전용) · **usable**: 1 (`415efbff`, 125 lines/93 parsed, 2026-08-06) — 나머지 6개는 tool call 자체가 없는 소규모 세션.
- **Attempts reconstructed**: 1개 window (11 implementation calls, 0 verification runs) — 세션 전체가 하나의 미검증 구현 덩어리라는 것이 segmentation의 정직한 결과.
- **Verification debt examples**: **1건 발견 (HIGH)** — "11 implementation calls were made without collecting any verification evidence". 실제 transcript 대조 결과 사람이 보는 결론과 일치.
- **Productive progress examples**: 실제 데이터에서 관측 사례 없음 → INCONCLUSIVE (억지로 판정하지 않음). synthetic 재현으로 로직 검증 (18→9, build fail→pass).
- **Dead-end examples**: 실제 데이터에서 실패 서명 자체가 없어 INCONCLUSIVE. failure-signature 해시(마스킹 후 sha256-8) 기반 탐지 구현 + 단위 검증.
- **Inconclusive examples**: 위 2건 — spec §7의 "명확한 evidence 없으면 INCONCLUSIVE" 원칙 준수.
- **False positives found**: 0. 단일 미검증 edit을 dead-end로 부르지 않는 가드 테스트 추가.
- **Privacy treatment**: raw transcript는 repo에 단 한 줄도 저장 안 됨. 커밋된 것은 sanitized derivative뿐 (이벤트 이름/bool/숫자/ms offset/8-hex 해시). 프라이버시 불변식이 테스트로 강제됨. Codex(`~/.codex/sessions`)는 discovery만 수행 (Claude first).

## POC-03

- **Hooks used**: PostToolUse 하나, matcher `Edit|Write|MultiEdit|Bash`, **프로젝트 스코프** (global settings 미수정). zero-nudge: 출력 없음, context 주입 없음, block 없음.
- **Events captured**: production hook을 실제 형식 payload로 100회 구동 → 100/100 올바른 sanitized JSONL 이벤트. live agent 트리거만 미수행 (quota).
- **Event schema**: `ts, sessionId(8), toolName, ok, fileHash(sha256-8), verificationKind, testsFailedCount(숫자만)` — 명령문·경로·출력 텍스트 저장 안 함 (소스 계약 테스트로 강제: no Jev, no fetch, no raw persistence).
- **p50 / p95 / max latency**: **101.0 / 119.3 / 134.4 ms** (100회, 프로세스 wall time). 귀속 분석: bare `node -e ""` 기준선 p50 ≈ 90.7 ms → 비용의 ~90%가 Node 기동, hook 로직은 1–3 ms. 10 ms 목표 미달 — **실측치 그대로 보고하며**, 제품화 전 컴파일드 바이너리 hook(~1–5 ms 예상) 필요.
- **Attempt reconstruction**: fail→fix→pass 시퀀스가 2-attempt timeline으로 재구성 ("Attempt 1 +0.9s 1 edit test: FAILED (1 failing)" → "Attempt 2 +2.5s 1 edit test: passed", productive finding `failed tests 1 → 0`). pre-attempt 기선 검증 run이 다음 attempt에 새는 segmentation 버그를 테스트가 잡아 수정.
- **Impact on Claude workflow**: live 세션으로 직접 측정은 불가했으나, hook은 tool 완료 후에만 실행되고 실패를 삼키며(try/catch → exit 0) 출력이 없어 관측자 고장이 에이전트를 깨뜨릴 수 없음. ~100 ms/tool-call은 일반적 tool 실행 시간 대비 작지만 누적 비용으로서 제품화 전 개선 필요.

## Jev

**NOT TESTED** — 이 환경에 `TYPESAFE_API_KEY` (또는 어떤 Jev provider 키)도 존재하지 않음 (env var 이름만 확인, 값은 출력하지 않음). POC-00에서 unavailable 경로와 에러 경로는 실증됨. POC-01 spec §9의 옵션 smoke (최대 3회)도 키 부재로 미실행.

## Git

- **Branches** (각 POC는 이전 POC 최종 커밋에서 분기):
  - `main` — bootstrap만 (`a0a5b5f`)
  - `poc/00-proof-of-progress` → `dc38412`
  - `poc/01-real-mobile-evidence` → `aaa5501`
  - `poc/02-real-session-replay` → `848a646`
  - `poc/03-live-observe` → `db54aec` (main 대비 16 commits)
  - `archive/pre-poc-skeleton` — POC 이전 발견 skeleton 보존
- **Remote push**: 미수행 — 이 머신에 `gh` CLI가 없고 원격이 설정되지 않음 (POC-00부터 동일 사유 기록).
- 최종 상태: working tree clean, clean build + **43/43 tests pass** (POC-00 회귀 포함).

## Biggest Problems

1. **POC-03 live leg 미검증** — Claude 계정 quota 소진(402)으로 "live 세션을 늦추지 않고 관찰"의 마지막 10%(실세션 부하 측정)가 남음.
2. **Hook hot path 10 ms 목표 미달** — Node 기동 비용으로 p50 ~101 ms. 기능 문제는 아니지만 intervention(POC-04) 전에 컴파일드 바이너리 hook이 사실상 필수.
3. **실제 history 표본 1개** — POC-02가 gate를 통과했으나 dead-end/productive의 실데이터 확인은 여전히 비어 있음. 표본이 늘기 전까지 이 두 라벨의 현장 유용성은 미증명.
4. **agent-device `logs` 채널이 이 Windows 호스트에서 불안정** — 크래시 증거를 provider 외부(Android crash buffer)에서 보충해야 했음. 다른 호스트/버전에서 재확인 필요.
5. **Jev 미검증** — semantic layer가 전체적으로 미가동 상태. 키 확립 시 latency/token/probability 실측이 POC-00 설계 위에 즉시 가능.

## Biggest Positive Findings

1. **"⚠ Different code. Same app."가 실제 기기에서 발화** — synthetic fixture가 아니라 살아있는 에뮬레이터 캡처 위에서 (POC-01 REAL C).
2. **실제 개발 history에서 Verification Debt 적중** — 11회 수정·검증 0회라는 실세션 패턴을 HIGH confidence로, false positive 0으로 포착 (POC-02 kill gate 통과의 핵심).
3. **노이즈에 강한 정규화** — 시계가 바뀌어도, ref 번호가 바뀌어도, PID/timestamp가 바뀌어도 서명은 불변. "가짜 변화"가 단 한 건도 발생하지 않음.
4. **전 비용 구조가 극단적으로 저렴** — deterministic eval µs, normalize <1 ms, worker ~1.7 ms. 비용 병목은 evidence 수집(provider CLI ~260 ms)뿐.
5. **관측과 개입의 완전한 분리** — hook은 출력도 실패 전파도 없는 순수 관측자. POC-04 이전까지 제품이 에이전트 행동에 영향을 줄 경로가 코드상 존재하지 않음.

## Star/Product Reality Check

"기술적으로 작동한다"는 이유로 "쓸 것"이라고 결론내리지 않는다. 현재 증거만으로:

- **Compelling user value?** 잠재적 핵심 가치는 확인됐으나 아직 좁다: 실증된 가치는 (a) 모바일 runtime 증명(에뮬레이터 필요), (b) 세션 replay의 debt 발견. "수정했다"는 말만 하고 검증 없이 넘어가는 에이전트를 잡는다는 제품 명제는 실데이터에서 1회 적중. 매 세션 반복될 때의 가치는 미측정.
- **Installation friction?** 높음. 풀 경험에 에뮬레이터/디바이스 + agent-device + 프로젝트 hook 설정이 필요. replay만은 `npm run poc:02`로 즉시 가능 — 이것이 현재 유일한 zero-friction 진입점.
- **False-positive risk?** 설계가 보수적(INCONCLUSIVE 우선, 활동량 무시)이라 현재 0건. 단, 표본 1 세션이라 위험도 표본도 작음.
- **Unique vs generic watchdog?** 고유함이 확인됨: activity(도구 호출 수, 패치 수)가 아니라 runtime/test 증거의 변화를 재므로, 일반 "hook 로깅 도구"와 결정적으로 다름. "Different code. Same app."은 즉시 이해되는 demo moment.
- **Demo-worthy moment?** 있음: 에뮬레이터 앞에서 패치만 바꾸고 앱이 멈춰 있는 상태에서 Pigeon이 한 줄 경고를 내는 장면. 그리고 실제 세션에서 "11 edits, 0 verifications" 한 줄.

## Recommendation

**GO → POC-04** — 단, 아래 전제 조건과 함께:

1. Claude Code quota/키 확립 → POC-03 live leg 완주 (실세션 부하 실측) + Jev 실측 (최대 3회).
2. hook을 컴파일드 바이너리(또는 동등한 저비용 형태)로 교체해 p50 < 10 ms 달성 후 intervention 설계 착수.

---

**POC-03 이후 구현을 멈췄습니다. POC-04 (intervention/nudge), dashboard, PigeonHub, 알림, iOS, Codex live 등은 시작하지 않았습니다.**
