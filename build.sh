#!/bin/sh
# 執行測試並打包成可在 Komari 後台上傳的插件 ZIP：dist/cn-speedtest.zip
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
node --test tests/*.test.js
mkdir -p dist
rm -f dist/cn-speedtest.zip
cd plugin
zip -r -q ../dist/cn-speedtest.zip komari-plugin.json script.js lib pages public -x "*.DS_Store*"
cd ..
echo "Built: dist/cn-speedtest.zip"
(sha256sum dist/cn-speedtest.zip 2>/dev/null || shasum -a 256 dist/cn-speedtest.zip) | awk '{print "SHA-256: " $1}'
