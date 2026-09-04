#!/usr/bin/env bash
set -euo pipefail

# Build + run Sprout on an iOS simulator.
#
# Why this exists instead of plain `npx cap run ios`:
# this project lives under ~/Documents, which iCloud's "Desktop & Documents
# Folders" sync manages via a file provider. That provider stamps
# com.apple.FinderInfo on directories it owns — including the .app bundle
# Xcode builds in ios/DerivedData. codesign rejects any bundle carrying
# FinderInfo ("resource fork, Finder information, or similar detritus not
# allowed"), so the default build fails at the signing step every time.
#
# Building with -derivedDataPath outside the synced folder sidesteps it.
# The durable fix is to move the repo somewhere iCloud does not manage
# (e.g. ~/Developer/SPROUT222), after which `npx cap run ios` works directly.

DEVICE="${1:-iPhone 17 Pro}"
DERIVED_DATA="${DERIVED_DATA:-/tmp/sprout-dd}"
BUNDLE_ID="com.sprout.rover"

UDID=$(xcrun simctl list devices available \
  | grep -F "$DEVICE (" \
  | head -1 \
  | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')

if [ -z "$UDID" ]; then
  echo "No available simulator named '$DEVICE'." >&2
  echo "Available:" >&2
  xcrun simctl list devices available | grep -E "iPhone|iPad" >&2
  exit 1
fi

echo "==> Building web assets"
npm run build

echo "==> Syncing to iOS"
npx cap sync ios

echo "==> Building app (DerivedData: $DERIVED_DATA)"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination "id=$UDID" -derivedDataPath "$DERIVED_DATA" \
  build -quiet

echo "==> Booting $DEVICE"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
open -a Simulator

echo "==> Installing and launching"
xcrun simctl install "$UDID" "$DERIVED_DATA/Build/Products/Debug-iphonesimulator/App.app"
xcrun simctl launch "$UDID" "$BUNDLE_ID"

echo "==> Running on $DEVICE"
