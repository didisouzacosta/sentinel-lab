#!/bin/sh
# Xcode Cloud: upload the archive's dSYMs to Sentinel after every archive.
# Needs these workflow environment variables (Xcode Cloud → workflow →
# Environment): SENTINEL_URL, SENTINEL_PROJECT and SENTINEL_AUTH_TOKEN
# (mark the token as Secret).
set -e

if [ "${CI_XCODEBUILD_ACTION:-}" != "archive" ] || [ -z "${CI_ARCHIVE_PATH:-}" ]; then
  echo "Sentinel: not an archive build, no dSYMs to upload."
  exit 0
fi

"$(dirname "$0")/sentinel-upload-dsyms.sh" "$CI_ARCHIVE_PATH/dSYMs"
