#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
#  FLASH AGENT — build an Android APK around the web app
#
#  Requirements on the build machine:
#    · Node.js 20+
#    · JDK 17            (java -version)
#    · Android SDK       (ANDROID_HOME, platform-tools + build-tools 34)
#
#  Usage:
#    FLASH_URL=https://your-domain.com bash android/build-apk.sh
#    FLASH_URL=https://your-domain.com bash android/build-apk.sh release
# ══════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-debug}"
FLASH_URL="${FLASH_URL:-}"

echo "▶ FLASH AGENT — Android build ($MODE)"

command -v node >/dev/null || { echo "✗ Node.js is required"; exit 1; }
command -v java >/dev/null || { echo "✗ JDK 17 is required (install openjdk-17-jdk)"; exit 1; }
[ -n "${ANDROID_HOME:-}${ANDROID_SDK_ROOT:-}" ] || echo "⚠ ANDROID_HOME / ANDROID_SDK_ROOT is not set — Gradle will fail unless local.properties points at the SDK."

echo "▶ installing Capacitor"
npm install --no-save @capacitor/core @capacitor/cli @capacitor/android

if [ ! -d android/app ]; then
  echo "▶ generating the native Android project"
  npx cap add android
fi

if [ -n "$FLASH_URL" ]; then
  echo "▶ pointing the shell at $FLASH_URL"
  node - "$FLASH_URL" <<'NODE'
const fs = require('fs');
const url = process.argv[2];
const p = 'android/capacitor.config.json';
const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
cfg.server = { ...(cfg.server || {}), url, cleartext: url.startsWith('http://') };
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
NODE
fi

echo "▶ syncing web assets + plugins"
npx cap sync android

cd android
if [ "$MODE" = "release" ]; then
  : "${SIGN_KEYSTORE:?set SIGN_KEYSTORE, SIGN_KEYSTORE_PASSWORD, SIGN_KEY_ALIAS, SIGN_KEY_PASSWORD}"
  ./gradlew assembleRelease \
    -Pandroid.injected.signing.store.file="$SIGN_KEYSTORE" \
    -Pandroid.injected.signing.store.password="$SIGN_KEYSTORE_PASSWORD" \
    -Pandroid.injected.signing.key.alias="$SIGN_KEY_ALIAS" \
    -Pandroid.injected.signing.key.password="$SIGN_KEY_PASSWORD"
  echo "✓ android/app/build/outputs/apk/release/app-release.apk"
else
  ./gradlew assembleDebug
  echo "✓ android/app/build/outputs/apk/debug/app-debug.apk"
fi

