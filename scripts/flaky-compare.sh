#!/usr/bin/env bash
#
# flaky-compare.sh — e2e flake hunt for the server.
#
# Runs the full Playwright suite N times, NO retries and fail-fast, unattended,
# tallying pass/fail + runtime. Built during the Go→Rust cutover to compare the two
# backends; Go is retired, so it now hunts flakes on the one server — chiefly the
# regression guard for the key-backup session_id fix (tasks/key-backup-...).
#
# Each run is `make e2e-local-rs SPEC="<filter> --retries=0 -x"`:
#   --retries=0  a flaky test FAILS the run instead of being retried green
#   -x           stop at the first failing test (we only need pass/fail per run)
#
# IMPORTANT (unattended + destructive):
#   - `make e2e-local-rs` runs `docker compose down -v` (WIPES MinIO) and binds :8080,
#     so runs are sequential and any data in MinIO is lost. Stop `make dev` first.
#   - Needs Docker running. caffeinate keeps the Mac awake.
#
# Usage:  ./scripts/flaky-compare.sh [N]                          # full suite, N=10
#         SPEC=credential-rotate-ui ./scripts/flaky-compare.sh 30 # one spec, 30x
#         UNTIL_FAIL=1 SPEC=credential-rotate-ui ./scripts/flaky-compare.sh
#                                                # hunt: cycle until the FIRST
#                                                # failure, keep its trace, stop
#
# SPEC is the same Playwright filter `make … SPEC=` takes. UNTIL_FAIL=1 stops at the
# first failing run (count becomes a safety cap, default 200) — the efficient way to
# capture a rare flake's trace.zip. Results + per-run logs: test-results/flaky/

set -uo pipefail

N="${1:-10}"
SPEC="${SPEC:-}"             # optional Playwright filter (env), same as `make … SPEC=…`
UNTIL_FAIL="${UNTIL_FAIL:-}" # env: stop at the FIRST failure — the rare-flake hunt
# In until-fail mode the run count is only a safety cap, so default it high.
[ -n "$UNTIL_FAIL" ] && N="${1:-200}"
PW_ARGS="--retries=0 -x"

# Don't let the HTML reporter auto-open a blocking report server on failure — it
# would hang this unattended loop at the first flake.
export PW_TEST_HTML_REPORT_OPEN=never

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/test-results/flaky"
mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
SUMMARY="$OUT/summary-$STAMP.txt"

# Keep the Mac awake for the whole run; caffeinate exits when this script (PID $$)
# does. -i: no idle sleep, -s: no system sleep on AC.
if command -v caffeinate >/dev/null 2>&1; then
	caffeinate -is -w "$$" &
fi

log() { echo "$@" | tee -a "$SUMMARY"; }

# run_one <run-number> — one full-suite run; returns the make exit status.
run_one() {
	local n="$1"
	local runlog="$OUT/run-$n-$STAMP.log"
	local start end secs status
	start=$(date +%s)
	# Left SPEC= is the Make variable; $SPEC is our optional filter prepended to
	# the no-retries/fail-fast flags.
	make e2e-local-rs SPEC="$SPEC $PW_ARGS" >"$runlog" 2>&1
	status=$?
	end=$(date +%s)
	secs=$((end - start))
	if [ "$status" -eq 0 ]; then
		log "run $n: PASS  ${secs}s"
	else
		local firstfail
		firstfail=$(grep -m1 -E '[0-9]+\).*›' "$runlog" | sed 's/^[[:space:]]*//')
		[ -z "$firstfail" ] && firstfail="(see log)"
		log "run $n: FAIL  ${secs}s  — $firstfail  [$runlog]"
		# Preserve Playwright's per-failure artifacts (trace.zip, screenshots) before
		# the NEXT run wipes them. Playwright runs from web/, so its output is
		# web/test-results/ (NOT repo-root test-results/, where our own logs go).
		local artdir="$OUT/run-$n-artifacts"
		mkdir -p "$artdir"
		find web/test-results -maxdepth 1 -type d -name '*-chromium' \
			-exec cp -R {} "$artdir/" \; 2>/dev/null || true
	fi
	return "$status"
}

log "flake-hunt: N=$N, spec='${SPEC:-<full suite>}', args='$PW_ARGS', started $STAMP"

for i in $(seq 1 "$N"); do
	run_one "$i"
	st=$?
	{ [ -n "$UNTIL_FAIL" ] && [ "$st" -ne 0 ]; } && break
done

log "== Summary =="
pass=$(grep -c "^run .*: PASS" "$SUMMARY")
fail=$(grep -c "^run .*: FAIL" "$SUMMARY")
mean=$(grep -E "^run .*(PASS|FAIL)  [0-9]+s" "$SUMMARY" |
	sed -E 's/.*(PASS|FAIL)  ([0-9]+)s.*/\2/' |
	awk '{ t += $1; n++ } END { if (n) printf "%.0f", t / n; else print "0" }')
log "total: $pass pass / $fail fail   (mean ${mean}s/run)"
log "done. full summary: $SUMMARY"
if [ -n "$UNTIL_FAIL" ] && grep -q ": FAIL" "$SUMMARY"; then
	log "caught a failure — trace/screenshots under $OUT/run-N-artifacts/"
	log "open it:  npx playwright show-trace $OUT/run-N-artifacts/*/trace.zip"
fi
