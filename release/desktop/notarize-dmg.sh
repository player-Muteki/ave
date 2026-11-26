#!/usr/bin/env bash
set -euo pipefail

[[ $# == 1 && -f "$1" ]] || { echo 'Expected one signed DMG' >&2; exit 1; }
: "${APPLE_TEAM_ID:?Missing Apple team ID}" "${APPLE_ID:?Missing Apple ID}" "${APPLE_APP_SPECIFIC_PASSWORD:?Missing notarization password}"
dmg=$1
codesign --verify --strict --verbose=2 -R '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' "$dmg"
codesign --display --verbose=4 "$dmg" 2>&1 | grep -Fx "TeamIdentifier=$APPLE_TEAM_ID"

receipt=$(xcrun notarytool submit "$dmg" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait --output-format json)
jq '{id, status, message}' <<< "$receipt"
jq -e '.status == "Accepted" and (.id | type == "string" and length > 0)' <<< "$receipt" > /dev/null
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
