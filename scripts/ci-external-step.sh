#!/usr/bin/env bash
# Runs one EXTERNAL sandbox step and classifies its exit code for GitHub
# Actions. It never turns a failure into success:
#   0 -> pass
#   3 -> "External sandbox/environment failure" annotation, step FAILS
#   * -> "Integration regression" annotation, step FAILS
# Usage: scripts/ci-external-step.sh "<label>" <command...>
set -uo pipefail
label=$1; shift
"$@"
code=$?
case $code in
  0) exit 0 ;;
  3) echo "::error title=External sandbox/environment failure — ${label}::The hosted Pay.sh sandbox, its RPC or the paid service's facilitator failed, or an externally submitted payment ended RECONCILIATION_REQUIRED (blocked, never retried). No product assertion failed. Re-run the 'Sandbox integration (external)' workflow when the sandbox is healthy; the deterministic CI workflow remains the correctness gate."
     exit 3 ;;
  *) echo "::error title=Integration regression — ${label}::A deterministic product assertion failed against the live sandbox (exit ${code}). Treat as a Virtual Haibin bug until shown otherwise."
     exit "$code" ;;
esac
