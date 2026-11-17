#!/bin/sh
# Static builds for the MiFis we might use. Mudi V2 (GL-E750V2) is ath79: mips (big-endian), softfloat.
set -e
cd "$(dirname "$0")"
mkdir -p dist
GOOS=linux GOARCH=mips   GOMIPS=softfloat CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o dist/kit-relay-mips .
GOOS=linux GOARCH=mipsle GOMIPS=softfloat CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o dist/kit-relay-mipsle .
GOOS=linux GOARCH=arm64  CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o dist/kit-relay-arm64 .
GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o dist/kit-relay-armv7 .
ls -la dist
