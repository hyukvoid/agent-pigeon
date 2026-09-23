#!/usr/bin/env bash
# Linux validation of the ACTUAL packed artifact — runs fully offline.
set -u
echo "=== versions ==="
node --version
npm --version
grep PRETTY_NAME /etc/os-release

echo "=== install packed tarball (network is disabled for this container) ==="
npm install --no-audit --no-fund ./in/agent-pigeon-0.1.0.tgz 2>&1 | tail -1
test -x node_modules/.bin/agent-pigeon && echo "bin installed ok"

echo "=== --help / --version ==="
node_modules/.bin/agent-pigeon --help | head -3
node_modules/.bin/agent-pigeon --version

echo "=== replay with SPACES in path (human) ==="
node_modules/.bin/agent-pigeon replay \
  --claude-dir "in/dir with spaces/claude/projects" \
  --codex-dir  "in/dir with spaces/codex/sessions" \
  --source all | head -30

echo "=== replay --json (turn-aware counts) ==="
node_modules/.bin/agent-pigeon replay \
  --claude-dir "in/dir with spaces/claude/projects" \
  --codex-dir  "in/dir with spaces/codex/sessions" \
  --json | node -e "
let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);
console.log(JSON.stringify({attempts:j.attempts,implChanges:j.implementationChanges,implTurns:j.implementationTurns,recognized:j.recognizedVerificationRuns,unverified:j.unverifiedStretches,productive:j.productiveLoops},null,1))});"

echo "=== malformed history fail-safe ==="
node_modules/.bin/agent-pigeon replay --claude-dir "in/dir with spaces/claude/projects" --source claude --json >/dev/null 2>&1
echo "exit=$? (0 = corrupt file did not fail the run)"

echo "=== read-only: checksums before/after ==="
md5sum $(find in -type f | sort) > /tmp/before.md5
node_modules/.bin/agent-pigeon replay --claude-dir "in/dir with spaces/claude/projects" --codex-dir "in/dir with spaces/codex/sessions" >/dev/null 2>&1
md5sum $(find in -type f | sort) > /tmp/after.md5
diff /tmp/before.md5 /tmp/after.md5 && echo "READ-ONLY CONFIRMED (all history checksums identical)"

echo "=== unexpected files written anywhere under /work? ==="
find /work -newer /work/in/agent-pigeon-0.1.0.tgz -type f | grep -v node_modules || echo "NONE (only node_modules from install)"

echo "=== big session (5 MB) resource check ==="
mkdir -p big/claude/projects/big
cp in/big-session.jsonl big/claude/projects/big/s.jsonl
/usr/bin/time -v node_modules/.bin/agent-pigeon replay --claude-dir big/claude/projects --source claude --json > /dev/null 2> /tmp/time.txt || \
node_modules/.bin/agent-pigeon replay --claude-dir big/claude/projects --source claude --json > /dev/null 2>&1
grep -E "Elapsed|Maximum resident" /tmp/time.txt | head -2 || echo "(GNU time not available in image)"

echo "=== LINUX VALIDATION COMPLETE ==="
