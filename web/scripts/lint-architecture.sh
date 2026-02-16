#!/usr/bin/env bash
#
# Enforces the layered architecture:
#
#   routes  → hooks → lib
#   routes  → components → lib
#
# Rules:
#   routes/      no className (no styling in orchestrators)
#   hooks/       must be .ts not .tsx (no JSX in behavior layer)
#   components/  no useEffect/useCallback/useMemo/useRef (no side effects; useState OK)
#   components/  no value imports from @/hooks/ (type imports OK)
#   lib/         no imports from @/routes/, @/hooks/, @/components/
#   hooks/       no imports from @/routes/ or @/components/

set -euo pipefail

cd "$(dirname "$0")/.."

errors=0

fail() {
    echo "  FAIL: $1"
    errors=$((errors + 1))
}

# ── routes/: no className ────────────────────────────────────────────
echo "Checking routes/ — no className..."
while IFS= read -r match; do
    fail "$match"
done < <(grep -rn 'className' src/routes/ 2>/dev/null || true)

# ── hooks/: must be .ts not .tsx ─────────────────────────────────────
echo "Checking hooks/ — no .tsx files..."
while IFS= read -r f; do
    fail "$f — hooks must be .ts, not .tsx"
done < <(find src/hooks/ -name '*.tsx' 2>/dev/null || true)

# ── components/ (excl ui/): no side-effect hooks ─────────────────────
echo "Checking components/ — no useEffect/useCallback/useMemo/useRef..."
while IFS= read -r match; do
    fail "$match"
done < <(grep -rn 'useEffect\|useCallback\|useMemo\|useRef' src/components/ --include='*.tsx' --include='*.ts' --exclude-dir=ui 2>/dev/null || true)

# ── components/ (excl ui/): no value imports from @/hooks/ ───────────
echo "Checking components/ — no value imports from @/hooks/..."
while IFS= read -r match; do
    fail "$match"
done < <(grep -rn "from '@/hooks/" src/components/ --include='*.tsx' --include='*.ts' --exclude-dir=ui 2>/dev/null | grep -v 'import type' || true)

# ── lib/: no imports from routes, hooks, or components ───────────────
echo "Checking lib/ — no imports from @/routes/, @/hooks/, @/components/..."
while IFS= read -r match; do
    fail "$match"
done < <(grep -rn "from '@/routes/\|from '@/hooks/\|from '@/components/" src/lib/ 2>/dev/null || true)

# ── hooks/: no imports from routes or components ─────────────────────
echo "Checking hooks/ — no imports from @/routes/ or @/components/..."
while IFS= read -r match; do
    fail "$match"
done < <(grep -rn "from '@/routes/\|from '@/components/" src/hooks/ 2>/dev/null || true)

# ── Summary ──────────────────────────────────────────────────────────
echo ""
if [ "$errors" -gt 0 ]; then
    echo "Architecture lint: $errors violation(s) found."
    exit 1
else
    echo "Architecture lint: all checks passed."
fi
