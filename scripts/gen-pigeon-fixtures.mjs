#!/usr/bin/env node
/**
 * Generates the Pigeon JSONL demo/validation fixtures into fixtures/pigeon/.
 *
 * The fixtures are realistic coding-session event streams (not hardcoded UI
 * data — the UI derives everything from these events). Deterministic: a fixed
 * base time and fixed ids, so diffs stay stable.
 *
 *   A  simple-success      files read → changed → tests pass
 *   B  failure-recovery    tests fail → inspect → fix → tests pass; build fail → fix → pass
 *   C  parallel-agents     main + research/backend/tests subagents, backend failure recovered
 *   D  acceptance-login    the directive's acceptance scenario (2 failures, both recovered)
 *
 * Run: node scripts/gen-pigeon-fixtures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pigeon');
const BASE = Date.parse('2026-09-24T09:00:00.000Z');

let seq = 0;
let sessionSeq = 0;

function makeEmitter(sessionId, source) {
  const emit = (offsetMs, type, extra = {}, agentId = 'main') => {
    seq++;
    return {
      id: `e${String(seq).padStart(4, '0')}`,
      sessionId,
      agentId,
      type,
      timestamp: new Date(BASE + offsetMs).toISOString(),
      source,
      ...extra,
    };
  };
  return emit;
}

function newSession(label, source) {
  sessionSeq++;
  seq = 0;
  return { sessionId: `${label}-${String(sessionSeq).padStart(3, '0')}`, source, emit: null };
}

function write(name, events) {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, name);
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  console.log(`${name}: ${events.length} events`);
}

// ---------------------------------------------------------------- Fixture A
{
  const s = newSession('simple-success', 'generic-jsonl');
  const emit = (offsetMs, type, extra = {}, agentId = 'main') => {
    seq++;
    return {
      id: `e${String(seq).padStart(4, '0')}`,
      sessionId: s.sessionId,
      agentId,
      type,
      timestamp: new Date(BASE + offsetMs).toISOString(),
      source: s.source,
      ...extra,
    };
  };
  const ev = [
    emit(0, 'SESSION_STARTED', { summary: 'Session started in ~/work/inventory-api' }),
    emit(4000, 'MESSAGE', { summary: 'Add stock level validation to the inventory API', metadata: { role: 'user' } }),
    emit(15000, 'FILE_READ', { toolName: 'Read', filePath: 'src/routes/stock.ts', status: 'ok', summary: 'Read src/routes/stock.ts' }),
    emit(22000, 'FILE_READ', { toolName: 'Read', filePath: 'src/app.ts', status: 'ok', summary: 'Read src/app.ts' }),
    emit(24000, 'FILE_READ', { toolName: 'Read', filePath: 'src/models/inventory.ts', status: 'ok', summary: 'Read src/models/inventory.ts' }),
    emit(31000, 'TOOL_CALLED', { toolName: 'Grep', status: 'ok', summary: 'Searched for "quantity" in src/routes' }),
    emit(34000, 'FILE_READ', { toolName: 'Read', filePath: 'src/middleware/validate.ts', status: 'ok', summary: 'Read src/middleware/validate.ts' }),
    emit(37000, 'FILE_READ', { toolName: 'Read', filePath: 'src/errors.ts', status: 'ok', summary: 'Read src/errors.ts' }),
    emit(40000, 'TOOL_CALLED', { toolName: 'Grep', status: 'ok', summary: 'Searched for "BadRequest" in src' }),
    emit(44000, 'MESSAGE', { summary: 'The stock route accepts negative quantities. Adding validation in the route handler.', metadata: { role: 'assistant' } }),
    emit(48000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'src/routes/stock.ts', status: 'running', summary: 'Modified src/routes/stock.ts' }),
    emit(52000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'src/models/inventory.ts', status: 'running', summary: 'Modified src/models/inventory.ts' }),
    emit(57000, 'FILE_READ', { toolName: 'Read', filePath: 'src/routes/stock.ts', status: 'ok', summary: 'Read src/routes/stock.ts' }),
    emit(61000, 'TEST_STARTED', { toolName: 'Bash', command: 'npm test', status: 'running', summary: 'Ran npm test' }),
    emit(88000, 'TEST_PASSED', { toolName: 'Bash', command: 'npm test', status: 'ok', summary: 'npm test — passed', metadata: { testsFailedCount: 0 } }),
    emit(92000, 'MESSAGE', { summary: 'Validation added: POST /stock now rejects quantities below zero. All 14 tests pass.', metadata: { role: 'assistant' } }),
    emit(95000, 'SESSION_COMPLETED', { status: 'ok', summary: 'Session completed', metadata: { outcome: 'success' } }),
  ];
  write('a-simple-success.pigeon.jsonl', ev);
}

// ---------------------------------------------------------------- Fixture B
{
  const s = newSession('failure-recovery', 'generic-jsonl');
  const emit = (offsetMs, type, extra = {}, agentId = 'main') => {
    seq++;
    return {
      id: `e${String(seq).padStart(4, '0')}`,
      sessionId: s.sessionId,
      agentId,
      type,
      timestamp: new Date(BASE + offsetMs).toISOString(),
      source: s.source,
      ...extra,
    };
  };
  const routine = [];
  // Routine research reads before the first edit.
  for (let i = 0; i < 8; i++) {
    routine.push(emit(20000 + i * 7000, 'FILE_READ', {
      toolName: 'Read',
      filePath: `src/modules/module${i + 1}.ts`,
      status: 'ok',
      summary: `Read src/modules/module${i + 1}.ts`,
    }));
  }
  const moreRoutine = [];
  for (let i = 0; i < 6; i++) {
    moreRoutine.push(emit(76000 + i * 6000, 'FILE_READ', {
      toolName: 'Read',
      filePath: `src/config/config${i + 1}.ts`,
      status: 'ok',
      summary: `Read src/config/config${i + 1}.ts`,
    }));
  }
  const ev = [
    emit(0, 'SESSION_STARTED', { summary: 'Session started in ~/work/parser-service' }),
    emit(3000, 'MESSAGE', { summary: 'Fix the config parser: nested arrays are silently dropped', metadata: { role: 'user' } }),
    ...routine,
    ...moreRoutine,
    emit(96000, 'MESSAGE', { summary: 'The array branch in parseValue() returns the scalar fallback. Fixing the branch order.', metadata: { role: 'assistant' } }),
    emit(104000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'src/parser.ts', status: 'running', summary: 'Modified src/parser.ts' }),
    emit(112000, 'TEST_STARTED', { toolName: 'Bash', command: 'npm test', status: 'running', summary: 'Ran npm test' }),
    emit(136000, 'TEST_FAILED', {
      toolName: 'Bash',
      command: 'npm test',
      status: 'error',
      error: 'AssertionError: expected [1,2,3] to deeply equal []',
      summary: 'npm test — 4 tests failed',
      metadata: { testsFailedCount: 4 },
    }),
    emit(139000, 'MESSAGE', { summary: '4 parser tests fail — the array branch now runs but drops elements. Inspecting the tokenizer.', metadata: { role: 'assistant' } }),
    emit(147000, 'FILE_READ', { toolName: 'Read', filePath: 'src/schema.ts', status: 'ok', summary: 'Read src/schema.ts' }),
    emit(158000, 'FILE_READ', { toolName: 'Read', filePath: 'src/tokenizer.ts', status: 'ok', summary: 'Read src/tokenizer.ts' }),
    emit(172000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'src/parser.ts', status: 'running', summary: 'Modified src/parser.ts' }),
    emit(180000, 'TEST_STARTED', { toolName: 'Bash', command: 'npm test', status: 'running', summary: 'Ran npm test' }),
    emit(205000, 'TEST_PASSED', { toolName: 'Bash', command: 'npm test', status: 'ok', summary: 'npm test — passed', metadata: { testsFailedCount: 0 } }),
    emit(210000, 'MESSAGE', { summary: 'Parser fixed: nested arrays survive tokenization. All 41 tests pass.', metadata: { role: 'assistant' } }),
    emit(216000, 'BUILD_STARTED', { toolName: 'Bash', command: 'npm run build', status: 'running', summary: 'Ran npm run build' }),
    emit(242000, 'BUILD_FAILED', {
      toolName: 'Bash',
      command: 'npm run build',
      status: 'error',
      error: 'error TS2345: Argument of type "string | number" is not assignable to parameter of type "string"',
      summary: 'npm run build — failed',
    }),
    emit(245000, 'FILE_READ', { toolName: 'Read', filePath: 'src/parser.ts', status: 'ok', summary: 'Read src/parser.ts' }),
    emit(254000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'src/parser.ts', status: 'running', summary: 'Modified src/parser.ts' }),
    emit(260000, 'BUILD_STARTED', { toolName: 'Bash', command: 'npm run build', status: 'running', summary: 'Ran npm run build' }),
    emit(287000, 'BUILD_PASSED', { toolName: 'Bash', command: 'npm run build', status: 'ok', summary: 'npm run build — passed' }),
    emit(290000, 'TEST_STARTED', { toolName: 'Bash', command: 'npm test', status: 'running', summary: 'Ran npm test' }),
    emit(315000, 'TEST_PASSED', { toolName: 'Bash', command: 'npm test', status: 'ok', summary: 'npm test — passed', metadata: { testsFailedCount: 0 } }),
    emit(318000, 'MESSAGE', { summary: 'Build and tests green. Summary: branch-order fix in parseValue plus a type narrowing.', metadata: { role: 'assistant' } }),
    emit(324000, 'SESSION_COMPLETED', { status: 'ok', summary: 'Session completed', metadata: { outcome: 'success' } }),
  ];
  write('b-failure-recovery.pigeon.jsonl', ev);
}

// ---------------------------------------------------------------- Fixture C
{
  const s = newSession('parallel-agents', 'generic-jsonl');
  const emit = (offsetMs, type, extra = {}, agentId = 'main') => {
    seq++;
    return {
      id: `e${String(seq).padStart(4, '0')}`,
      sessionId: s.sessionId,
      agentId,
      type,
      timestamp: new Date(BASE + offsetMs).toISOString(),
      source: s.source,
      ...extra,
    };
  };
  const ev = [
    emit(0, 'SESSION_STARTED', { summary: 'Session started in ~/work/storefront' }),
    emit(4000, 'MESSAGE', { summary: 'Add coupon redemption to checkout: research the pricing rules, implement the backend, update tests', metadata: { role: 'user' } }),

    emit(12000, 'SUBAGENT_STARTED', { status: 'running', summary: 'Subagent started: research pricing rules', metadata: { task: 'research pricing rules' } }, 'research-agent'),
    emit(13000, 'SUBAGENT_STARTED', { status: 'running', summary: 'Subagent started: implement coupon backend', metadata: { task: 'implement coupon backend' } }, 'backend-agent'),
    emit(14000, 'SUBAGENT_STARTED', { status: 'running', summary: 'Subagent started: keep the test suite green', metadata: { task: 'keep the test suite green' } }, 'tests-agent'),

    // research-agent: reads only
    emit(20000, 'FILE_READ', { toolName: 'Read', filePath: 'src/pricing/rules.ts', status: 'ok', summary: 'Read src/pricing/rules.ts' }, 'research-agent'),
    emit(34000, 'FILE_READ', { toolName: 'Read', filePath: 'src/pricing/coupons.ts', status: 'ok', summary: 'Read src/pricing/coupons.ts' }, 'research-agent'),
    emit(47000, 'FILE_READ', { toolName: 'Read', filePath: 'docs/coupons.md', status: 'ok', summary: 'Read docs/coupons.md' }, 'research-agent'),
    emit(61000, 'FILE_READ', { toolName: 'Read', filePath: 'src/cart/totals.ts', status: 'ok', summary: 'Read src/cart/totals.ts' }, 'research-agent'),
    emit(74000, 'FILE_READ', { toolName: 'Read', filePath: 'src/pricing/index.ts', status: 'ok', summary: 'Read src/pricing/index.ts' }, 'research-agent'),
    emit(87000, 'TOOL_CALLED', { toolName: 'WebSearch', status: 'ok', summary: 'Searched: coupon stacking rules ecommerce' }, 'research-agent'),
    emit(92000, 'FILE_READ', { toolName: 'Read', filePath: 'src/pricing/discount.ts', status: 'ok', summary: 'Read src/pricing/discount.ts' }, 'research-agent'),
    emit(99000, 'TOOL_CALLED', { toolName: 'Grep', status: 'ok', summary: 'Searched for "applyDiscount" in src' }, 'research-agent'),
    emit(110000, 'MESSAGE', { summary: 'Pricing rules: coupons apply after member discount, max one per cart.', metadata: { role: 'assistant' } }, 'research-agent'),
    emit(118000, 'SUBAGENT_COMPLETED', { status: 'ok', summary: 'research-agent finished', metadata: { outcome: 'success' } }, 'research-agent'),

    // backend-agent: implements, hits a build failure, recovers
    emit(25000, 'FILE_READ', { toolName: 'Read', filePath: 'src/checkout/index.ts', status: 'ok', summary: 'Read src/checkout/index.ts' }, 'backend-agent'),
    emit(40000, 'FILE_READ', { toolName: 'Read', filePath: 'src/checkout/coupons.ts', status: 'ok', summary: 'Read src/checkout/coupons.ts' }, 'backend-agent'),
    emit(50000, 'FILE_READ', { toolName: 'Read', filePath: 'src/checkout/session.ts', status: 'ok', summary: 'Read src/checkout/session.ts' }, 'backend-agent'),
    emit(58000, 'FILE_CREATED', { toolName: 'Write', filePath: 'src/checkout/redeem.ts', status: 'running', summary: 'Created src/checkout/redeem.ts' }, 'backend-agent'),
    emit(66000, 'MESSAGE', { summary: 'Redemption endpoint sketched; wiring it into checkout totals next.', metadata: { role: 'assistant' } }, 'backend-agent'),
    emit(73000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'src/checkout/index.ts', status: 'running', summary: 'Modified src/checkout/index.ts' }, 'backend-agent'),
    emit(82000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'src/checkout/redeem.ts', status: 'running', summary: 'Modified src/checkout/redeem.ts' }, 'backend-agent'),
    emit(90000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'src/checkout/coupons.ts', status: 'running', summary: 'Modified src/checkout/coupons.ts' }, 'backend-agent'),
    emit(104000, 'BUILD_STARTED', { toolName: 'Bash', command: 'npm run build', status: 'running', summary: 'Ran npm run build' }, 'backend-agent'),
    emit(128000, 'BUILD_FAILED', {
      toolName: 'Bash',
      command: 'npm run build',
      status: 'error',
      error: 'error TS2304: Cannot find name "applyCoupon"',
      summary: 'npm run build — failed',
    }, 'backend-agent'),
    emit(131000, 'MESSAGE', { summary: 'Build fails: applyCoupon is not re-exported from checkout/coupons.', metadata: { role: 'assistant' } }, 'backend-agent'),
    emit(140000, 'FILE_READ', { toolName: 'Read', filePath: 'src/checkout/coupons.ts', status: 'ok', summary: 'Read src/checkout/coupons.ts' }, 'backend-agent'),
    emit(154000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'src/checkout/coupons.ts', status: 'running', summary: 'Modified src/checkout/coupons.ts' }, 'backend-agent'),
    emit(162000, 'BUILD_STARTED', { toolName: 'Bash', command: 'npm run build', status: 'running', summary: 'Ran npm run build' }, 'backend-agent'),
    emit(188000, 'BUILD_PASSED', { toolName: 'Bash', command: 'npm run build', status: 'ok', summary: 'npm run build — passed' }, 'backend-agent'),
    emit(195000, 'SUBAGENT_COMPLETED', { status: 'ok', summary: 'backend-agent finished', metadata: { outcome: 'success' } }, 'backend-agent'),

    // tests-agent: keeps tests green
    emit(30000, 'FILE_READ', { toolName: 'Read', filePath: 'test/checkout.test.ts', status: 'ok', summary: 'Read test/checkout.test.ts' }, 'tests-agent'),
    emit(38000, 'FILE_READ', { toolName: 'Read', filePath: 'test/helpers/cart.ts', status: 'ok', summary: 'Read test/helpers/cart.ts' }, 'tests-agent'),
    emit(45000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'test/checkout.test.ts', status: 'running', summary: 'Modified test/checkout.test.ts' }, 'tests-agent'),
    emit(54000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'test/helpers/cart.ts', status: 'running', summary: 'Modified test/helpers/cart.ts' }, 'tests-agent'),
    emit(65000, 'TEST_STARTED', { toolName: 'Bash', command: 'npm test', status: 'running', summary: 'Ran npm test' }, 'tests-agent'),
    emit(95000, 'TEST_FAILED', {
      toolName: 'Bash',
      command: 'npm test',
      status: 'error',
      error: 'AssertionError: expected totals.totals 4497 to deeply equal 4600',
      summary: 'npm test — 2 tests failed',
      metadata: { testsFailedCount: 2 },
    }, 'tests-agent'),
    emit(98000, 'MESSAGE', { summary: 'Totals test expects the pre-coupon amount — updating the fixture matrix.', metadata: { role: 'assistant' } }, 'tests-agent'),
    emit(105000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'test/checkout.test.ts', status: 'running', summary: 'Modified test/checkout.test.ts' }, 'tests-agent'),
    emit(112000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'test/fixtures/carts.ts', status: 'running', summary: 'Modified test/fixtures/carts.ts' }, 'tests-agent'),
    emit(120000, 'TEST_STARTED', { toolName: 'Bash', command: 'npm test', status: 'running', summary: 'Ran npm test' }, 'tests-agent'),
    emit(148000, 'TEST_PASSED', { toolName: 'Bash', command: 'npm test', status: 'ok', summary: 'npm test — passed', metadata: { testsFailedCount: 0 } }, 'tests-agent'),
    emit(155000, 'TEST_STARTED', { toolName: 'Bash', command: 'npm test', status: 'running', summary: 'Ran npm test (confirming stability)' }, 'tests-agent'),
    emit(183000, 'TEST_PASSED', { toolName: 'Bash', command: 'npm test', status: 'ok', summary: 'npm test — passed', metadata: { testsFailedCount: 0 } }, 'tests-agent'),
    emit(210000, 'SUBAGENT_COMPLETED', { status: 'ok', summary: 'tests-agent finished', metadata: { outcome: 'success' } }, 'tests-agent'),

    emit(225000, 'CHECKPOINT', { summary: 'All subagents done; totals verified against coupon matrix' }),
    emit(232000, 'MESSAGE', { summary: 'Coupon redemption lands in checkout: redeem.ts + totals wiring, suite green.', metadata: { role: 'assistant' } }),
    emit(240000, 'SESSION_COMPLETED', { status: 'ok', summary: 'Session completed', metadata: { outcome: 'success' } }),
  ];
  write('c-parallel-agents.pigeon.jsonl', ev);
}

// ------------------------------------------------------- Fixture D (acceptance)
{
  const s = newSession('acceptance-login', 'generic-jsonl');
  const emit = (offsetMs, type, extra = {}, agentId = 'main') => {
    seq++;
    return {
      id: `e${String(seq).padStart(4, '0')}`,
      sessionId: s.sessionId,
      agentId,
      type,
      timestamp: new Date(BASE + offsetMs).toISOString(),
      source: s.source,
      ...extra,
    };
  };
  const ev = [
    emit(0, 'SESSION_STARTED', { summary: 'Session started in ~/work/portal' }),
    emit(4000, 'MESSAGE', { summary: 'fix login', metadata: { role: 'user' } }),

    emit(12000, 'FILE_READ', { toolName: 'Read', filePath: 'src/middleware.ts', status: 'ok', summary: 'Read src/middleware.ts' }),
    emit(20000, 'TOOL_CALLED', { toolName: 'Grep', status: 'ok', summary: 'Searched for "session" in src' }),
    emit(26000, 'FILE_READ', { toolName: 'Read', filePath: 'src/routes/login.ts', status: 'ok', summary: 'Read src/routes/login.ts' }),
    emit(34000, 'FILE_READ', { toolName: 'Read', filePath: 'src/auth.ts', status: 'ok', summary: 'Read src/auth.ts' }),
    emit(40000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'src/middleware.ts', status: 'running', summary: 'Modified src/middleware.ts' }),
    emit(52000, 'TEST_STARTED', { toolName: 'Bash', command: 'npm test', status: 'running', summary: 'Ran npm test' }),
    emit(78000, 'TEST_FAILED', {
      toolName: 'Bash',
      command: 'npm test',
      status: 'error',
      error: "TypeError: Cannot read properties of undefined (reading 'session')",
      summary: 'npm test — 4 tests failed',
      metadata: { testsFailedCount: 4 },
    }),

    emit(86000, 'MESSAGE', { summary: 'Login tests fail on an undefined session in middleware. Inspecting auth.', metadata: { role: 'assistant' } }),
    emit(90000, 'TOOL_CALLED', { toolName: 'Grep', status: 'ok', summary: 'Searched for "redirect" in src' }),
    emit(94000, 'FILE_READ', { toolName: 'Read', filePath: 'src/auth.ts', status: 'ok', summary: 'Read src/auth.ts' }),
    emit(101000, 'FILE_READ', { toolName: 'Read', filePath: 'src/session.ts', status: 'ok', summary: 'Read src/session.ts' }),
    emit(108000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'src/middleware.ts', status: 'running', summary: 'Modified src/middleware.ts' }),

    emit(116000, 'SUBAGENT_STARTED', { status: 'running', summary: 'Subagent started: verify login with tests', metadata: { task: 'verify login with tests' } }, 'test-agent'),
    emit(118000, 'SUBAGENT_STARTED', { status: 'running', summary: 'Subagent started: verify login in the browser', metadata: { task: 'verify login in the browser' } }, 'browser-agent'),

    emit(126000, 'TEST_STARTED', { toolName: 'Bash', command: 'npm test', status: 'running', summary: 'Ran npm test' }, 'test-agent'),
    emit(152000, 'TEST_PASSED', { toolName: 'Bash', command: 'npm test', status: 'ok', summary: 'npm test — passed', metadata: { testsFailedCount: 0 } }, 'test-agent'),
    emit(158000, 'SUBAGENT_COMPLETED', { status: 'ok', summary: 'test-agent finished', metadata: { outcome: 'success' } }, 'test-agent'),

    emit(134000, 'COMMAND_STARTED', { toolName: 'Bash', command: 'node scripts/browser-check.js /login', status: 'running', summary: 'Ran node scripts/browser-check.js /login' }, 'browser-agent'),
    emit(167000, 'COMMAND_COMPLETED', {
      toolName: 'Bash',
      command: 'node scripts/browser-check.js /login',
      exitCode: 1,
      status: 'error',
      error: 'login redirect landed on /login?error=undefined_session',
      summary: 'node scripts/browser-check.js /login finished (exit 1)',
    }, 'browser-agent'),
    emit(170000, 'MESSAGE', { summary: 'Browser check fails: the redirect drops the session param.', metadata: { role: 'assistant' } }, 'browser-agent'),
    emit(178000, 'FILE_READ', { toolName: 'Read', filePath: 'src/config.ts', status: 'ok', summary: 'Read src/config.ts' }),
    emit(190000, 'FILE_CHANGED', { toolName: 'Edit', filePath: 'src/config.ts', status: 'running', summary: 'Modified src/config.ts' }),
    emit(198000, 'COMMAND_STARTED', { toolName: 'Bash', command: 'node scripts/browser-check.js /login', status: 'running', summary: 'Ran node scripts/browser-check.js /login' }, 'browser-agent'),
    emit(226000, 'COMMAND_COMPLETED', {
      toolName: 'Bash',
      command: 'node scripts/browser-check.js /login',
      exitCode: 0,
      status: 'ok',
      summary: 'node scripts/browser-check.js /login finished (exit 0)',
    }, 'browser-agent'),
    emit(232000, 'SUBAGENT_COMPLETED', { status: 'ok', summary: 'browser-agent finished', metadata: { outcome: 'success' } }, 'browser-agent'),

    emit(236000, 'CHECKPOINT', { summary: 'Tests and browser verification both green' }),
    emit(240000, 'MESSAGE', { summary: 'Login fixed: middleware session guard corrected, redirect config restored. Tests and browser check pass.', metadata: { role: 'assistant' } }),
    emit(248000, 'SESSION_COMPLETED', { status: 'ok', summary: 'Session completed', metadata: { outcome: 'success' } }),
  ];
  write('d-acceptance-login.pigeon.jsonl', ev);
}
