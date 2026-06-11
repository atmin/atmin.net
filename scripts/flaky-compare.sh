#!/usr/bin/env bash
#
# flaky-compare.sh — measure e2e flakiness, Go server vs Rust server (ADR-0018).
#
# Runs the full Playwright suite N times against each backend, NO retries and
# fail-fast, fully unattended, and tallies pass/fail + runtime. Turns "Rust feels
# stabler" into a measured flake rate.
#
# Each run is `make e2e-local[-rs] SPEC="--retries=0 -x"`:
#   --retries=0  a flaky test FAILS the run instead of being retried green
#                (the local default is retries:1, which hides exactly the flake
#                 we're trying to measure)
#   -x           stop at the first failing test — we only need pass/fail per run,
#                and a failed run shouldn't grind through the whole suite
#
# IMPORTANT, because it's unattended and destructive:
#   - Both Make targets run `docker compose down -v` (WIPES the MinIO volume) and
#     bind :8080, so runs are strictly sequential and any data in MinIO is lost.
#   - Stop `make dev` first — the targets pkill stray servers on :8080.
#   - Needs Docker running.
#   - ~N * 2.2 min * 2 backends (≈45 min for N=10). caffeinate keeps the Mac awake.
#
# Order is interleaved (go,rust,go,rust,…) so any time drift — the machine warming
# up, background load shifting over the ~45 min — hits both backends evenly instead
# of biasing one half. Set ORDER="blocks" for all-Go-then-all-Rust if you'd rather.
#
# Usage:  ./scripts/flaky-compare.sh [N]                          # full suite, N=10
#         SPEC=credential-rotate-ui ./scripts/flaky-compare.sh 30 # one spec, 30x
#
# SPEC is the same Playwright filter `make … SPEC=` takes (substring of the spec
# path, or "file -g 'title'"); empty = the whole suite. Scope it to hunt one flaky
# test fast. Results + per-run logs: test-results/flaky/

set -uo pipefail

N="${1:-10}"
ORDER="interleave"  # "interleave" | "blocks"
SPEC="${SPEC:-}"    # optional Playwright filter (env), same as `make … SPEC=…`
PW_ARGS="--retries=0 -x"

# Don't let the HTML reporter auto-open a blocking report server on failure — it
# would hang this unattended loop at the first flake (it did, once).
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

# run_one <label go|rust> <make-target> <run-number>
run_one() {
	local label="$1" target="$2" n="$3"
	local runlog="$OUT/$label-run-$n-$STAMP.log"
	local start end secs status
	start=$(date +%s)
	# Left SPEC= is the Make variable; $SPEC is our optional filter prepended to
	# the no-retries/fail-fast flags.
	make "$target" SPEC="$SPEC $PW_ARGS" >"$runlog" 2>&1
	status=$?
	end=$(date +%s)
	secs=$((end - start))
	if [ "$status" -eq 0 ]; then
		log "$label run $n: PASS  ${secs}s"
	else
		# Best-effort: the first failing test line Playwright prints under -x.
		local firstfail
		firstfail=$(grep -m1 -E '[0-9]+\).*›' "$runlog" | sed 's/^[[:space:]]*//')
		[ -z "$firstfail" ] && firstfail="(see log)"
		log "$label run $n: FAIL  ${secs}s  — $firstfail  [$runlog]"
		# Preserve Playwright's per-failure artifacts (trace.zip, screenshots,
		# video) before the NEXT run wipes test-results/ — otherwise the flake
		# we're hunting leaves nothing to open.
		local artdir="$OUT/$label-run-$n-artifacts"
		mkdir -p "$artdir"
		find test-results -maxdepth 1 -type d -name '*-chromium' \
			-exec cp -R {} "$artdir/" \; 2>/dev/null || true
	fi
}

log "flaky-compare: N=$N, order=$ORDER, spec='${SPEC:-<full suite>}', args='$PW_ARGS', started $STAMP"

case "$ORDER" in
interleave)
	for i in $(seq 1 "$N"); do
		run_one go e2e-local "$i"
		run_one rust e2e-local-rs "$i"
	done
	;;
*)
	log "== Go =="
	for i in $(seq 1 "$N"); do run_one go e2e-local "$i"; done
	log "== Rust =="
	for i in $(seq 1 "$N"); do run_one rust e2e-local-rs "$i"; done
	;;
esac

log "== Summary =="
for label in go rust; do
	pass=$(grep -c "^$label run .*: PASS" "$SUMMARY")
	fail=$(grep -c "^$label run .*: FAIL" "$SUMMARY")
	# Mean runtime across this backend's runs (anchored on PASS/FAIL so a digit in
	# a failing-test name can't be mistaken for the runtime).
	mean=$(grep -E "^$label run .*(PASS|FAIL)  [0-9]+s" "$SUMMARY" |
		sed -E 's/.*(PASS|FAIL)  ([0-9]+)s.*/\2/' |
		awk '{ t += $1; n++ } END { if (n) printf "%.0f", t / n; else print "0" }')
	log "$label: $pass pass / $fail fail of $N   (mean ${mean}s/run)"
done
log "done. full summary: $SUMMARY"
