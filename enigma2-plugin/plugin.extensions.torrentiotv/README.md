# TorrentioTV for Enigma2 (initial prototype)

This directory contains the first, diagnostic-only Enigma2 frontend prototype
for the VU+ Solo2 running BlackHole 3.1.0.I.

## Non-negotiable architecture

- Kodi and Enigma2 are alternative frontends, not concurrent clients.
- Only one client may own a playback session at a time.
- The existing Node.js Gateway and WebTorrent Worker remain the only streaming
  engine and the only authoritative torrent/RAM-buffer implementation.
- The receiver must not download torrent pieces or create a second media cache.
- Kodi, `server/gateway/server.js`, and `server/downloader/worker.js` are not
  modified by this prototype.

## Current milestone

The plugin can save the existing Gateway's LAN URL and query
`GET /api/status` asynchronously, without freezing the Enigma2 UI. It does not
prepare torrents, call playback lifecycle endpoints, or start native playback.

This intentionally establishes the Python/Enigma2 UI and network-client
foundation before testing the receiver's native HTTP player and Range/seek
behavior.

## Target runtime

Verified on the user's receiver:

- VU+ Solo2, BlackHole 3.1.0.I
- Linux 3.13.5, MIPS BMIPS5000
- Python 2.7.9; Python 3 is not installed
- Enigma2 experimental-git20121128-r192-bh157-bsp31
- GStreamer 1.4.5; native HTTP/MKV/Range playback still requires device tests

The source therefore avoids Python 3-only syntax and dependencies.

## Development install (manual prototype)

Copy the contents of this directory to:

```text
/usr/lib/enigma2/python/Plugins/Extensions/TorrentioTV/
```

The installed directory must contain `__init__.py`, `plugin.py`, and
`api.py`. Restart Enigma2 to load the plugin. This is a developer test
procedure, not yet a final IPK/ZIP package.

Open TorrentioTV from the Enigma2 Plugins menu, choose **Configure Gateway URL**,
and enter the LAN URL of the existing server, for example
`http://192.168.1.20:4000`. Then choose **Check Gateway / Worker**.

Keep the Gateway on a trusted LAN; its current API has no authentication.

## Not yet implemented or verified

- Catalog, metadata, streams, subtitles and Continue Watching screens
- Native Enigma2 playback using the gateway `/video.mkv` URL
- HTTP Range, seeking, pause/resume and long-playback behavior on the Solo2
- Playback callbacks and history updates
- Cross-client single-owner enforcement at the Gateway boundary
- Final package metadata and installation/uninstallation lifecycle

Do not treat the prototype as a working playback client until those tests pass.
