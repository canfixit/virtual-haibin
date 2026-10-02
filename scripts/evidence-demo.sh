#!/usr/bin/env bash
# PHASE 5A/5B LIVE DEMO -- portable evidence verified with the authority STOPPED.
#
# Host requirements: bash + Docker only (everything else runs in containers).
# Requires the stack to be up: docker compose up -d --wait
#
#   1. human approves summarize(dataset-a); agent buys it on the sandbox
#   2. export EvidenceBundleV1 (and a DENY bundle for export(dataset-a))
#   3. STOP the authority
#   4. standalone verifier, no network, pinned trust roots   -> VALID
#   5. tamper operation / amount / recipient / settlement / authority key -> INVALID
#   6. verifier --online against the sandbox RPC             -> settlement VERIFIED
#   7. restart the authority: same persistent key; old bundle still VALID
#
# Exit 0 pass / 1 INTEGRATION REGRESSION / 3 EXTERNAL ENVIRONMENT FAILURE
# (sandbox purchase uncertain, or the sandbox RPC unobservable online).
# Set EVIDENCE_DEMO_ONLINE=0 to skip step 6 (no outbound RPC from the verifier).
set -euo pipefail
cd "$(dirname "$0")/.."

ISSUER=/trust/issuer/trusted-issuer
AUTHORITY=/trust/authority/authority.pub
fail=0
external=0
expect() { # expect <wanted-exit> <label> <cmd...>
  local want=$1 label=$2; shift 2
  set +e; "$@" > ".evidence/last.out" 2>&1; local got=$?; set -e
  local overall; overall=$(grep -o '^overall: [A-Z]*' .evidence/last.out | head -1 || true)
  if [[ $got == "$want" ]]; then echo "  ok   $label ($overall)"; else echo "  FAIL $label: exit $got, wanted $want"; cat .evidence/last.out; fail=1; fi
}
verify() { docker compose run --rm -T --no-deps verifier verify "$@" --issuer-trust $ISSUER --authority-trust $AUTHORITY; }
# Whatever happens, never leave the authority stopped.
trap 'docker compose start authority >/dev/null 2>&1 || true' EXIT

mkdir -p .evidence
code="$(docker compose exec -T approver cat /keys/approval-code)"
key_before=$(docker compose exec -T authority cat /authority-trust/authority.pub)

echo "== 1-2. purchase + export"
set +e
out=$(docker compose run --rm -T --user "$(id -u):$(id -g)" -e APPROVER_CODE="$code" demo-driver node scripts/export-evidence.mjs 2>.evidence/export.err | tail -1)
export_code=${PIPESTATUS[0]}
set -e
if [[ $export_code == 3 ]]; then
  echo "  EXT  $(tail -1 .evidence/export.err)"
  echo "EXTERNAL ENVIRONMENT FAILURE: no product assertion failed; rerun when the sandbox is healthy."
  exit 3
elif [[ $export_code != 0 ]]; then
  echo "  FAIL export: exit $export_code"; cat .evidence/export.err
  echo "INTEGRATION REGRESSION"; exit 1
fi
echo "  $out"
allow=$(echo "$out" | sed -E 's/.*"allow":"([^"]+)".*/\1/')
deny=$(echo "$out" | sed -E 's/.*"deny":"([^"]+)".*/\1/')

echo "== 3. stop the authority"
docker compose stop authority >/dev/null 2>&1
echo "  authority: $(docker compose ps -a --format '{{.State}}' authority)"

echo "== 4. offline verification (verifier container has network_mode: none)"
expect 0 "ALLOW bundle VALID offline" verify "$allow" --offline
cp .evidence/last.out .evidence/offline-report.txt
expect 0 "DENY bundle VALID offline (consistent denial)" verify "$deny" --offline

echo "== 5. tampering"
for kind in operation amount recipient settlement authority-key; do
  docker compose run --rm -T --no-deps --user "$(id -u):$(id -g)" demo-driver node scripts/tamper-evidence.mjs "$allow" ".evidence/tampered-$kind.json" "$kind" >/dev/null 2>&1
  expect 1 "tampered $kind -> INVALID" verify ".evidence/tampered-$kind.json" --offline
done

echo "== 6. online settlement verification (authority still stopped)"
if [[ "${EVIDENCE_DEMO_ONLINE:-1}" == "0" ]]; then
  echo "  skipped (EVIDENCE_DEMO_ONLINE=0)"
else
  set +e
  docker compose run --rm -T --no-deps verifier-online verify "$allow" --online --issuer-trust $ISSUER --authority-trust $AUTHORITY > .evidence/online-report.txt 2>&1
  online_code=$?
  set -e
  grep -E "^\s+(VERIFIED|INVALID|INDETERMINATE)\s+\*?\s*settlement" .evidence/online-report.txt || true
  case $online_code in
    0) echo "  ok   online VALID (settlement independently observed)" ;;
    2) echo "  EXT  online INDETERMINATE: sandbox RPC could not be observed (external)"; external=1 ;;
    *) echo "  FAIL online verification: exit $online_code"; fail=1 ;;
  esac
fi

echo "== 7. restart authority: persistent key"
docker compose start authority >/dev/null 2>&1
docker compose up -d --wait authority >/dev/null 2>&1
key_after=$(docker compose exec -T authority cat /authority-trust/authority.pub)
if [[ "$key_before" == "$key_after" ]]; then echo "  ok   authority key unchanged across restart ($key_after)"; else echo "  FAIL key changed: $key_before -> $key_after"; fail=1; fi
expect 0 "pre-restart bundle still VALID" verify "$allow" --offline

if [[ $fail != 0 ]]; then echo "Evidence demo: INTEGRATION REGRESSION"; exit 1; fi
if [[ $external != 0 ]]; then echo "Evidence demo: EXTERNAL ENVIRONMENT FAILURE (no product assertion failed)"; exit 3; fi
echo "All evidence demo checks passed."
