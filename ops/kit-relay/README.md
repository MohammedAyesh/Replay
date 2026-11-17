# kit-relay — Watch on the pitch

Full-quality playback at the pitch, straight off the camera's SD card, with no mobile data.
Runs on the kit's MiFi. The app's **Watch on the pitch** page (`/kit/s/<id>/watch`) asks it for
the day's files and plays one: **Low** is the camera's H.264 sub-stream file (plays on every
phone), **High** is the 4K H.265 main-stream file (iPhones, and Android phones whose chip
decodes H.265).

Why a relay at all: a secure page (https://replayjo.com) cannot read a plain-HTTP device on the
local network, and the camera sends no CORS headers. The relay answers over **HTTPS** on a name
that points at the MiFi, with the headers browsers want (`Access-Control-Allow-Origin` for
replayjo.com, `Access-Control-Allow-Private-Network`). Chrome asks once to allow access to
local-network devices; the app tells people to tap Allow. On a plain phone hotspot there is
nothing to run this on: that case waits for the native app.

```
GET /api/health                       {"camera": true}
GET /api/recordings?date=YYYY-MM-DD   {"recordings": [{start, end, main:{name,size}, sub:{name,size}}]}
GET /api/file?name=<file>             the MP4, Range passed through
```

## Hardware

GL.iNet **Mudi V2 (GL-E750V2)**: 4G MiFi with a 7000 mAh battery, runs OpenWrt, WireGuard
built in. About USD 140–152 from GL.iNet's store (about EUR 145, GBP 128–139). The 5G
**Puli AX (GL-XE3000)** is USD 499 if 4G isn't enough. Mudi V2 is ath79, so it takes the
`mips` (big-endian, softfloat) build.

## One kit, once

1. **Network.** Give each kit its own LAN, e.g. kit 1 = 192.168.67.0/24 with the camera reserved at
   .101, and a WireGuard peer to vps1 like the Jordan Galaxy router (10.99.0.x, keepalive 25,
   camera subnet routed). Then vps1 reaches the camera exactly as it reaches cam1–cam3, and the
   SD pulls, the snapshot and the WiFi change all work.
2. **Camera.** Join the camera to the kit's WiFi once (Reolink app), set its clock to Amman, and
   add it on vps1: `/root/.config/reolink-cli/aliases.toml` (`[cameras.cam4] host = "192.168.67.101:9000"`)
   and `/etc/replay/kits.json` (`{"camera4": {"host": "192.168.67.101"}}`).
3. **Name and certificate.** DNS `kit1.lan.replayjo.com` → the MiFi's LAN address (192.168.67.1).
   Issue a certificate for it on vps1 with a DNS-01 challenge (the name is private, so HTTP-01
   can't reach it) and copy `cert.pem`/`key.pem` to `/etc/kit-relay/` on the MiFi. Renew every
   60 days over the WireGuard link.
4. **Relay.** `./build.sh`, copy `dist/kit-relay-mips` to `/usr/bin/kit-relay`, put the camera
   password in `/etc/kit-relay/pass` (mode 600), and run it from procd:
   `kit-relay -listen :443 -camera 192.168.67.101`. Check `https://kit1.lan.replayjo.com/api/health`
   from a phone on the kit WiFi.
5. **App.** Admin → field or academy console → Cameras → Add camera: name, `camera4`, the kit
   WiFi name and password, and `https://kit1.lan.replayjo.com` as the relay address.

## Fragile on purpose (Mohammed, 2026-11-17: "build it even if it's fragile")

- Some Reolink firmware won't serve `Download` with Range; then a file plays from the start only.
- If the camera wrote the MP4 with its index at the end, playback waits for the whole file.
- cam3's firmware (4989) refuses the plain HTTP API for transfers; a 4989 kit can't use this.
