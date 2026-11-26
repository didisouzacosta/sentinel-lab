#!/usr/bin/env bash
# Checks a freshly deployed Sentinel Lab from the outside, without credentials:
# the Access gate, the public health route and that every open route still
# demands its own credential. Used by .github/workflows/lab-deploy.yml after
# each deploy (a failure there rolls production back); also runnable by hand:
#
#   bash lab/smoke-production.sh https://sentinel.adrianosouzacosta.com.br
set -euo pipefail

BASE="${1:?usage: smoke-production.sh <base url>}"
failures=0

# expect <status> <description> <curl args...>; retries to ride out propagation.
expect() {
	local want="$1" what="$2"
	shift 2
	local got=""
	for _ in 1 2 3 4 5; do
		got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" || true)
		[ "$got" = "$want" ] && break
		sleep 3
	done
	if [ "$got" = "$want" ]; then
		echo "ok    $want  $what"
	else
		echo "FAIL  $what: expected $want, got ${got:-no answer}"
		failures=$((failures + 1))
	fi
}

expect 200 "GET /api/health is public" "$BASE/api/health"
expect 302 "GET / sends the browser to Cloudflare Access" "$BASE/"
expect 401 "GET /api/0/ demands a token" "$BASE/api/0/"
expect 401 "GET /mcp demands a token" "$BASE/mcp"
expect 401 "an envelope with an unknown DSN key is refused" \
	-X POST "$BASE/api/1/envelope/" \
	-H 'Content-Type: application/x-sentry-envelope' \
	-H 'X-Sentry-Auth: Sentry sentry_version=7, sentry_key=00000000000000000000000000000000' \
	--data-binary $'{}\n{"type":"event"}\n{}'
expect 401 "an integration webhook with a bad signature is refused" \
	-X POST "$BASE/api/hooks/kaneo/00000000-0000-4000-8000-000000000000" \
	-H 'Content-Type: application/json' \
	-H 'X-Kaneo-Signature: 0000000000000000000000000000000000000000000000000000000000000000' \
	--data '{}'

if [ "$failures" -gt 0 ]; then
	echo "$failures smoke check(s) failed."
	exit 1
fi
echo "All smoke checks passed."
