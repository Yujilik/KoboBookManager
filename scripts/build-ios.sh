#!/bin/sh
# Tests + unsigned release IPA in artifacts/ (macOS with Xcode). Users sideload and sign it
# with their own Apple ID, so no certificate, team or provisioning profile is embedded.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
version="$(node -p "require('./package.json').version")"
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$' || { echo "Invalid version in package.json" >&2; exit 1; }

npm test
./scripts/test-ios-native.sh
npm run ios:sync

derived="$root/ios/DerivedData"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -sdk iphoneos \
  -destination generic/platform=iOS -derivedDataPath "$derived" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/Payload"
cp -R "$derived/Build/Products/Release-iphoneos/App.app" "$stage/Payload/"
# Drop debug symbols (and the local build paths they contain) from every binary.
xcrun strip -S -x "$stage/Payload/App.app/App"
for framework in "$stage"/Payload/App.app/Frameworks/*.framework; do
  [ -d "$framework" ] && xcrun strip -S -x "$framework/$(basename "$framework" .framework)"
done
mkdir -p artifacts
ipa="$root/artifacts/KoboBookManager-$version.ipa"
rm -f "$ipa"
(cd "$stage" && zip -qry -X "$ipa" Payload)
echo "IPA generated: $ipa"
