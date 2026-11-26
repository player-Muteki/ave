#!/usr/bin/env bash
# Install into a fresh directory under the test account's Applications folder.
set -euo pipefail
dmg=$1
desktop=$2
mount=$(mktemp -d)
mkdir -p "$HOME/Applications"
install_dir=$(mktemp -d "$HOME/Applications/AVE-QA.XXXXXX")
attached=0
cleanup() {
  if [[ $attached == 1 ]]; then hdiutil detach "$mount"; fi
  rmdir "$mount" 2>/dev/null || true
  rm -rf "$install_dir"
}
trap cleanup EXIT
hdiutil attach -readonly -nobrowse -mountpoint "$mount" "$dmg"
attached=1
ditto "$mount/AVE.app" "$install_dir/AVE.app"
hdiutil detach "$mount"
attached=0
if [[ -n "${AVE_VERIFY_APPLE_TEAM_ID:-}" ]]; then
  app="$install_dir/AVE.app"
  codesign --verify --deep --strict --verbose=2 "$app"
  codesign --display --verbose=4 "$app" 2>&1 | grep -Fx "TeamIdentifier=$AVE_VERIFY_APPLE_TEAM_ID"
  spctl --assess --type execute --verbose=2 "$app"
fi
node "$desktop/e2e/packaged-app-smoke.js" --app "$install_dir/AVE.app"
