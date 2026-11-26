const express = require('express');
const WebTorrent = require('webtorrent');
const MemoryChunkStore = require('memory-chunk-store');

const app = express();
app.use(express.json());

process.on('uncaughtException', (err) => {
  console.error('[WORKER] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[WORKER] Unhandled Rejection:', err);
});

const MAX_RAM_MB = 650;
const IDLE_TIMEOUT_MS = 180000;
const PAUSE_TIMEOUT_MS = 900000;
const PREBUFFER_BYTES = 24 * 1024 * 1024;
const TARGET_AHEAD_BYTES = 96 * 1024 * 1024;
const REFILL_THRESHOLD_BYTES = 64 * 1024 * 1024;
const KEEP_BEHIND_BYTES = 16 * 1024 * 1024;

const client = new WebTorrent({
  maxConns: 55,
  uploadLimit: 51200,
  utp: true
});

let activeTorrent = null;
let activeFile = null;
let isPaused = false;
let lastActivity = 0;
let lastByteOffset = 0;
let activeStreams = new Set();

function closeAllStreams() {
  for (const s of activeStreams) {
    try { s.destroy(); } catch (e) {}
  }
  activeStreams.clear();
}

function stopAndClean(reason) {
  if (reason) console.log(`[WORKER] Oprire si eliberare RAM: ${reason}`);
  closeAllStreams();
  isPaused = false;
  lastActivity = 0;
  lastByteOffset = 0;

  if (activeTorrent) {
    const t = activeTorrent;
    activeTorrent = null;
    activeFile = null;
    try {
      if (t.store && Array.isArray(t.store.chunks)) {
        t.store.chunks.length = 0;
      }
      t.destroy({ destroyStore: true }, () => {
        if (global.gc) {
          try { global.gc(); } catch (e) {}
        }
        console.log('[WORKER] RAM eliberat complet.');
      });
    } catch (e) {
      console.error('[WORKER] Eroare la distrugerea torrentului:', e.message);
    }
  }
}

function manageRamBuffer(byteOffset) {
  if (!activeTorrent || !activeFile) return;
  try {
    lastByteOffset = byteOffset;
    const pieceLen = activeTorrent.pieceLength;
    const fileStartPiece = Math.floor(activeFile.offset / pieceLen);
    const fileEndPiece = Math.floor((activeFile.offset + activeFile.length - 1) / pieceLen);

    const headProtectPieces = Math.max(2, Math.ceil((1024 * 1024) / pieceLen));
    const tailProtectPieces = Math.max(3, Math.ceil((2 * 1024 * 1024) / pieceLen));
    const headEnd = Math.min(fileEndPiece, fileStartPiece + headProtectPieces);
    const tailStart = Math.max(fileStartPiece, fileEndPiece - tailProtectPieces);

    activeTorrent.select(fileStartPiece, headEnd, true);
    activeTorrent.select(tailStart, fileEndPiece, true);

    const currentPiece = Math.floor((activeFile.offset + byteOffset) / pieceLen);
    const keepBehindPieces = Math.ceil(KEEP_BEHIND_BYTES / pieceLen);
    const targetAheadPieces = Math.ceil(TARGET_AHEAD_BYTES / pieceLen);
    const refillPieces = Math.ceil(REFILL_THRESHOLD_BYTES / pieceLen);

    const dropStart = headEnd + 1;
    const dropUntil = Math.min(tailStart - 1, currentPiece - keepBehindPieces);
    if (dropUntil > dropStart) {
      activeTorrent.deselect(dropStart, dropUntil, false);
      if (activeTorrent.store && activeTorrent.store.chunks) {
        for (let p = dropStart; p < dropUntil; p++) {
          if (activeTorrent.store.chunks[p]) {
            activeTorrent.store.chunks[p] = null;
          }
        }
      }
    }

    const maxCheckPiece = Math.min(fileEndPiece, currentPiece + targetAheadPieces);
    let consecutiveReady = 0;
    for (let p = currentPiece; p <= maxCheckPiece; p++) {
      if (activeTorrent.bitfield && activeTorrent.bitfield.get(p)) {
        consecutiveReady++;
      } else {
        break;
      }
    }

    if (consecutiveReady >= targetAheadPieces) {
      const pauseStart = currentPiece + targetAheadPieces;
      if (tailStart - 1 >= pauseStart) {
        activeTorrent.deselect(pauseStart, tailStart - 1, false);
      }
    } else if (consecutiveReady < refillPieces && maxCheckPiece >= currentPiece) {
      activeTorrent.select(currentPiece, maxCheckPiece, true);
    }
  } catch (e) {}
}

setInterval(() => {
  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (rssMB > MAX_RAM_MB) {
    stopAndClean(`Limita de RAM depasita (${rssMB} MB > ${MAX_RAM_MB} MB)`);
    return;
  }

  if (!activeTorrent || !activeFile) return;

  if (!isPaused) {
    manageRamBuffer(lastByteOffset);
  }

  if (lastActivity === 0) return;
  const idleFor = Date.now() - lastActivity;

  if (!isPaused && idleFor > IDLE_TIMEOUT_MS) {
    stopAndClean('Inactivitate Kodi > 3 minute (Dead-man switch)');
  } else if (isPaused && idleFor > PAUSE_TIMEOUT_MS) {
    stopAndClean('Pauza prelungita > 15 minute');
  }
}, 2000);

app.post('/load', (req, res) => {
  const { magnet, fileIdx } = req.body;
  if (!magnet) return res.status(400).json({ error: 'Lipseste magnet' });

  stopAndClean('Incarcare torrent nou');

  let responded = false;
  const metaTimeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      stopAndClean('Timeout conectare/prebuffer (35s - prea putini seederi)');
      res.status(504).json({ error: 'Timeout prebuffer torrent' });
    }
  }, 35000);

  console.log('[WORKER] Conectare la peers in RAM...');
  const torrent = client.add(magnet, {
    store: MemoryChunkStore,
    sequential: true
  });

  activeTorrent = torrent;

  torrent.on('error', (err) => {
    console.error('[WORKER] Eroare torrent:', err.message);
    if (!responded) {
      responded = true;
      clearTimeout(metaTimeout);
      stopAndClean('Eroare torrent');
      res.status(500).json({ error: err.message });
    }
  });

  torrent.on('ready', () => {
    if (responded) return;

    torrent.files.forEach((f) => f.deselect());

    let target = (typeof fileIdx === 'number' && torrent.files[fileIdx])
      ? torrent.files[fileIdx]
      : torrent.files.reduce((a, b) => (a.length > b.length ? a : b));

    activeFile = target;
    lastActivity = Date.now();
    lastByteOffset = 0;
    isPaused = false;

    manageRamBuffer(0);

    const pieceLen = torrent.pieceLength;
    const fileStartPiece = Math.floor(target.offset / pieceLen);
    const fileEndPiece = Math.floor((target.offset + target.length - 1) / pieceLen);
    const neededPrebufferPieces = Math.min(
      fileEndPiece - fileStartPiece + 1,
      Math.max(4, Math.ceil(PREBUFFER_BYTES / pieceLen))
    );

    const checkPrebuffer = setInterval(() => {
      if (responded || activeTorrent !== torrent) {
        clearInterval(checkPrebuffer);
        return;
      }
      let readyCount = 0;
      for (let p = fileStartPiece; p < fileStartPiece + neededPrebufferPieces; p++) {
        if (torrent.bitfield && torrent.bitfield.get(p)) {
          readyCount++;
        } else {
          break;
        }
      }
      if (readyCount >= neededPrebufferPieces) {
        clearInterval(checkPrebuffer);
        responded = true;
        clearTimeout(metaTimeout);
        lastActivity = Date.now();
        console.log(`[WORKER] Prebuffer 24MB gata in RAM: ${target.name}`);
        res.json({
          ready: true,
          name: target.name,
          size: target.length
        });
      }
    }, 400);
  });
});

app.head('/raw-stream', (req, res) => {
  if (!activeFile) return res.status(404).end();
  lastActivity = Date.now();
  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': activeFile.length,
    'Content-Type': 'video/x-matroska'
  });
  res.end();
});

app.get('/raw-stream', (req, res) => {
  if (!activeFile) return res.status(404).send('Niciun fisier activ');

  lastActivity = Date.now();
  isPaused = false;

  const fileSize = activeFile.length;
  const range = req.headers.range;

  let start = 0;
  let end = fileSize - 1;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    start = parseInt(parts[0], 10);
    if (parts[1] && parts[1].trim() !== '') {
      end = parseInt(parts[1], 10);
    } else {
      end = Math.min(start + 16 * 1024 * 1024 - 1, fileSize - 1);
    }

    if (isNaN(start) || start >= fileSize || end >= fileSize || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    manageRamBuffer(start);

    const chunkSize = (end - start) + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/x-matroska'
    });
  } else {
    manageRamBuffer(0);
    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': fileSize,
      'Content-Type': 'video/x-matroska'
    });
  }

  const stream = activeFile.createReadStream({ start, end });
  activeStreams.add(stream);

  const cleanupStream = () => {
    activeStreams.delete(stream);
    try { stream.destroy(); } catch (e) {}
  };

  stream.on('error', () => {
    cleanupStream();
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      cleanupStream();
    } else {
      activeStreams.delete(stream);
    }
  });

  stream.pipe(res);
});

app.post('/pause', (req, res) => {
  isPaused = true;
  lastActivity = Date.now();
  closeAllStreams();
  console.log('[WORKER] Kodi -> PAUSE');
  res.json({ ok: true });
});

app.post('/resume', (req, res) => {
  isPaused = false;
  lastActivity = Date.now();
  manageRamBuffer(lastByteOffset);
  console.log('[WORKER] Kodi -> RESUME');
  res.json({ ok: true });
});

app.post('/stop', (req, res) => {
  stopAndClean('Comanda explicita STOP de la Kodi');
  res.json({ ok: true });
});

app.get('/status', (req, res) => {
  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (!activeTorrent || !activeFile) {
    return res.json({ active: false, ramMB: rssMB });
  }
  res.json({
    active: true,
    paused: isPaused,
    ramMB: rssMB,
    name: activeFile.name,
    speedKB: Math.round(activeTorrent.downloadSpeed / 1024),
    peers: activeTorrent.numPeers
  });
});

app.listen(4001, '127.0.0.1', () => {
  console.log('[WORKER] Ruleaza 100% in RAM pe 127.0.0.1:4001 (0 bytes pe SSD)');
});
