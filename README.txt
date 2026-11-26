TorrentioTV - 100% RAM Streamer (Zero SSD Writes)
================================================

1. SERVER (Manjaro / Linux / RPi):
   - Deschide terminalul in folderul server/
   - Ruleaza: npm install
   - Porneste worker-ul: node downloader/worker.js
   - Porneste gateway-ul: node gateway/server.js

2. KODI ADDON:
   - Arhiveaza folderul plugin.video.torrentiotv ca plugin.video.torrentiotv.zip
   - In Kodi: Add-ons -> Install from zip file
   - Configureaza IP-ul serverului in Addon Settings.
