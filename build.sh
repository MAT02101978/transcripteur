#!/usr/bin/env bash
# Compile l'APK signé. Prérequis : JDK 17+, Gradle 8.13+, Android SDK (platform 35) via ANDROID_HOME.
set -euo pipefail
cd "$(dirname "$0")"
[ -f transcripteur.jks ] || keytool -genkeypair -keystore transcripteur.jks -alias transcripteur \
  -storepass transcripteur -keypass transcripteur -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Transcripteur, O=Cabinet Faudemer, C=FR"
gradle --no-daemon assembleRelease
cp app/build/outputs/apk/release/app-release.apk Transcripteur.apk
echo "OK → $(pwd)/Transcripteur.apk"
