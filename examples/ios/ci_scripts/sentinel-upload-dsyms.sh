#!/bin/sh
# Upload every dSYM under a folder to Sentinel, using only curl (no
# sentry-cli). Works in Xcode Cloud, GitHub Actions, an Xcode build phase
# or a terminal.
#
#   SENTINEL_URL=https://sentinel.example.com \
#   SENTINEL_PROJECT=my-app \
#   SENTINEL_AUTH_TOKEN=wst_... \
#   ./sentinel-upload-dsyms.sh path/to/MyApp.xcarchive/dSYMs
#
# SENTINEL_AUTH_TOKEN: an API token with the "write" scope (dashboard →
# Settings → API tokens). Keep it in your CI's secrets, never in the repo.
# SENTINEL_STRICT=1 makes a failed upload fail the build (default: warn).

set -u
DIR="${1:-}"
ORG="${SENTINEL_ORG:-sentinel}"
STRICT="${SENTINEL_STRICT:-0}"

# Xcode treats an "error:" line as a failed build, so outside strict mode
# problems are reported as warnings and the build goes on.
fail() {
  if [ "$STRICT" = "1" ]; then
    echo "error: $1" >&2
    exit 1
  fi
  echo "warning: $1" >&2
  exit 0
}

[ -n "$DIR" ] || fail "usage: $0 <folder with .dSYM bundles>"
[ -d "$DIR" ] || fail "no such folder: $DIR"
[ -n "${SENTINEL_URL:-}" ] || fail "SENTINEL_URL is not set"
[ -n "${SENTINEL_PROJECT:-}" ] || fail "SENTINEL_PROJECT is not set"
[ -n "${SENTINEL_AUTH_TOKEN:-}" ] || fail "SENTINEL_AUTH_TOKEN is not set"

# Percent-encodes a value for the query string (POSIX sh, byte by byte).
urlencode() {
  LC_ALL=C
  rest="$1"
  out=""
  while [ -n "$rest" ]; do
    c="${rest%"${rest#?}"}"
    rest="${rest#?}"
    case "$c" in
      [a-zA-Z0-9._~-]) out="$out$c" ;;
      *) out="$out$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

ENDPOINT="${SENTINEL_URL%/}/api/0/projects/$ORG/$SENTINEL_PROJECT/debug-files/"
uploaded=0
failed=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The DWARF file inside each bundle is what Sentinel stores (universal
# files are split per architecture on the server).
find "$DIR" -type f -path '*.dSYM/Contents/Resources/DWARF/*' > "$TMP/files"
[ -s "$TMP/files" ] || fail "no dSYMs under $DIR (is DEBUG_INFORMATION_FORMAT set to dwarf-with-dsym?)"

while IFS= read -r file; do
  name="$(basename "$file")"
  status="$(gzip -c "$file" | curl -sS -o "$TMP/answer" -w '%{http_code}' -X POST \
    "$ENDPOINT?name=$(urlencode "$name")" \
    -H "Authorization: Bearer $SENTINEL_AUTH_TOKEN" \
    -H 'Content-Type: application/octet-stream' \
    -H 'Content-Encoding: gzip' \
    --data-binary @-)"
  if [ "$status" = "201" ]; then
    uploaded=$((uploaded + 1))
    ids="$(grep -o '"debugId":"[^"]*"' "$TMP/answer" | cut -d'"' -f4 | tr '\n' ' ')"
    echo "uploaded $name → $ids"
  else
    failed=$((failed + 1))
    echo "warning: $name was not uploaded (HTTP $status): $(head -c 300 "$TMP/answer")" >&2
  fi
done < "$TMP/files"

echo "Sentinel: $uploaded dSYM file(s) uploaded, $failed failed."
[ "$failed" -eq 0 ] || fail "$failed dSYM upload(s) failed"
