#!/bin/sh
# Compile and run the iOS native unit tests (platform-independent Swift) on macOS.
# Needs only the Xcode Command Line Tools; mirrors android/app/src/test.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/ios/App/App"
out="${TMPDIR:-/tmp}/kobo-ios-native-tests"
swiftc -O -swift-version 5 -o "$out" \
  "$app/KoboError.swift" "$app/BookContent.swift" "$app/UpdatePolicy.swift" "$app/ExportPayload.swift" \
  "$app/DeliveryServer.swift" "$app/FolderAccess.swift" "$root/ios/App/NativeTests/main.swift"
"$out"
