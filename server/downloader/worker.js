const express = require('express');
const WebTorrent = require('webtorrent');

const app = express();
app.use(express.json());

process.on('uncaughtException', (err) => {
  console.error('[WORKER] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[WORKER] Unhandled Rejection:', err);
});

class RingMemoryStore {
  constructor(chunkLength, opts = {}) {
    this.chunkLength = chunkLength;
    this.chunks = new Map();
    this.closed = false;
  }
  put(index, buf, cb = () => {}) {
    if (this.closed) return cb(new Error('Store closed'));
    this.chunks.set(index, Buffer.from(buf));
    cb(null);
  }
  get(index, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (this.closed) return cb(new Error('Store closed'));
    const buf = this.chunks.get(index);
    if (!buf) return cb(new Error(`Chunk ${index} missing`));
    const offset = (opts && opts.offset) || 0;
    const len = (opts && opts.length) || (buf.length - offset);
    cb(null, buf.subarray(offset, offset + len));
  }
  evictBefore(minIndex) {
    for (const key of this.chunks.keys()) {
      if (key < minIndex) this.chunks.delete(key);
    }
  }
  close(cb = () => {}) { this.chunks.clear(); this.closed = true; cb(null); }
  destroy(cb = () => {}) { this.close(cb); }
}

const MAX_RAM_MB = 650;
const IDLE_TIMEOUT_MS = 45000;
const PAUSE_TIMEOUT_MS = 600000;
const WINDOW_BYTES = 64 * 1024 * 1024;
const PREBUFFER_BYTES = 8 * 1024 * 1024;
const PREBUFFER_TIMEOUT_MS = 30000;
const WINDOW_UPDATE_BYTES = 2 * 1024 * 1024;

const client = new WebTorrent({
  maxConns: 30,
  uploadLimit: 51200,
  utp: false
});

let activeTorrent = null;
let activeFile = null;
let isPaused = false;
let lastActivity = 0;
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

  if (activeTorrent) {
    const t = activeTorrent;
    activeTorrent = null;
    activeFile = null;
    try {
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

setInterval(() => {
  if (!activeTorrent) return;

  if (global.gc) {
    try { global.gc(); } catch (e) {}
  }

  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (rssMB > MAX_RAM_MB) {
    stopAndClean(`Limita de RAM depasita (${rssMB} MB > ${MAX_RAM_MB} MB)`);
    return;
  }

  if (lastActivity === 0) return;
  // An open playback stream is active even when Kodi temporarily stops requesting bytes.
  if (!isPaused && activeStreams.size > 0) return;

  const idleFor = Date.now() - lastActivity;
  if (!isPaused && idleFor > IDLE_TIMEOUT_MS) {
    stopAndClean('Inactivitate Kodi > 45 secunde (Dead-man switch)');
  } else if (isPaused && idleFor > PAUSE_TIMEOUT_MS) {
    stopAndClean('Pauza prelungita > 10 minute');
  }
}, 3000);

function updateRamWindow(byteOffset) {
  if (!activeTorrent || !activeFile) return;
  try {
    const pieceLen = activeTorrent.pieceLength;
    const fileStartPiece = Math.floor(activeFile.offset / pieceLen);
    const fileEndPiece = Math.floor((activeFile.offset + activeFile.length - 1) / pieceLen);

    const currentPiece = Math.floor((activeFile.offset + byteOffset) / pieceLen);
    const windowPieces = Math.ceil(WINDOW_BYTES / pieceLen);

    const keepBehindPieces = Math.ceil((16 * 1024 * 1024) / pieceLen);
    const dropUntil = currentPiece - keepBehindPieces;
    if (dropUntil > fileStartPiece) {
      activeTorrent.deselect(fileStartPiece, dropUntil, false);
      // Keep downloaded pieces in the store: WebTorrent may still request them
      // after a backward seek. Deselecting stops prioritizing them without deleting data.
    }

    const endPriority = Math.min(fileEndPiece, currentPiece + windowPieces);
    if (endPriority >= currentPiece) {
      activeTorrent.select(currentPiece, endPriority, true);
    }
  } catch (e) {}
}

function prebufferFile(file) {
  const bytes = Math.min(file.length, PREBUFFER_BYTES);
  if (bytes <= 0) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    let received = 0;
    let settled = false;
    const stream = file.createReadStream({ start: 0, end: bytes - 1 });
    activeStreams.add(stream);
    const timer = setTimeout(() => finish(new Error('Timeout pre-buffering')) , PREBUFFER_TIMEOUT_MS);
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeStreams.delete(stream);
      if (err) {
        try { stream.destroy(); } catch (e) {}
        reject(err);
      } else {
        resolve(received);
      }
    }
    stream.on('data', (chunk) => {
      received += chunk.length;
      lastActivity = Date.now();
    });
    stream.on('end', () => finish(null));
    stream.on('error', (err) => finish(err));
  });
}

app.post('/load', (req, res) => {
  const { magnet, fileIdx } = req.body;
  if (!magnet) return res.status(400).json({ error: 'Lipseste magnet' });

  stopAndClean('Incarcare torrent nou');

  let responded = false;
  const metaTimeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      stopAndClean('Timeout metadate (25s - fara seederi)');
      res.status(504).json({ error: 'Timeout metadate torrent' });
    }
  }, 60000);

  console.log('[WORKER] Conectare la peers in RAM...');
  const torrent = client.add(magnet, {
    store: RingMemoryStore,
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
    clearTimeout(metaTimeout);

    torrent.files.forEach((f) => f.deselect());

    let target = (typeof fileIdx === 'number' && torrent.files[fileIdx])
      ? torrent.files[fileIdx]
      : torrent.files.reduce((a, b) => (a.length > b.length ? a : b));

    activeFile = target;
    lastActivity = Date.now();
    isPaused = false;

    updateRamWindow(0);

    console.log(`[WORKER] Pre-buffering initial ${Math.min(target.length, PREBUFFER_BYTES) / 1024 / 1024} MB...`);
    prebufferFile(target).then((bufferedBytes) => {
      if (responded || activeTorrent !== torrent) return;
      responded = true;
      clearTimeout(metaTimeout);
      lastActivity = Date.now();
      console.log(`[WORKER] Pregatit in RAM: ${target.name} (${Math.round(target.length / 1024 / 1024)} MB); pre-buffer: ${Math.round(bufferedBytes / 1024 / 1024)} MB`);
      res.json({
        ready: true,
        name: target.name,
        size: target.length,
        prebufferedBytes: bufferedBytes
      });
    }).catch((err) => {
      if (responded) return;
      responded = true;
      clearTimeout(metaTimeout);
      stopAndClean('Eroare la pre-buffering');
      if (!res.headersSent) res.status(504).json({ error: 'Nu s-au putut pre-incarca datele torrentului' });
      console.error('[WORKER] Pre-buffering esuat:', err.message);
    });
  });
});

function parseByteRange(header, fileSize) {
  if (!header) return { start: 0, end: fileSize - 1, partial: false };
  if (!/^bytes=\d*-\d*$/.test(header.trim()) || header.includes(',')) return null;
  const value = header.trim().slice(6);
  const [left, right] = value.split('-');
  let start;
  let end;
  if (left === '') {
    const suffixLength = Number(right);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(left);
    end = right === '' ? Math.min(start + 16 * 1024 * 1024 - 1, fileSize - 1) : Number(right);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= fileSize || start > end) return null;
    end = Math.min(end, fileSize - 1);
  }
  return { start, end, partial: true };
}

function sendStreamHeaders(req, res) {
  if (!activeFile) return res.status(404).end();
  const fileSize = activeFile.length;
  const range = parseByteRange(req.headers.range, fileSize);
  if (!range) {
    res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
    return res.end();
  }
  lastActivity = Date.now();
  if (req.method === 'GET') isPaused = false;
  if (req.method === 'GET') updateRamWindow(range.start);
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Length': range.end - range.start + 1,
    'Content-Type': 'video/x-matroska'
  };
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${fileSize}`;
  res.writeHead(range.partial ? 206 : 200, headers);
  return range;
}

app.head('/raw-stream', (req, res) => {
  if (!sendStreamHeaders(req, res)) return;
  res.end();
});

app.get('/raw-stream', (req, res) => {
  if (!activeFile) return res.status(404).send('Niciun fisier activ');
  const range = sendStreamHeaders(req, res);
  if (!range) return;
  const { start, end } = range;

  const stream = activeFile.createReadStream({ start, end });
  activeStreams.add(stream);
  let streamedBytes = 0;
  let nextWindowUpdate = WINDOW_UPDATE_BYTES;
  stream.on('data', (chunk) => {
    streamedBytes += chunk.length;
    lastActivity = Date.now();
    if (streamedBytes >= nextWindowUpdate) {
      updateRamWindow(Math.min(start + streamedBytes, activeFile.length - 1));
      nextWindowUpdate = streamedBytes + WINDOW_UPDATE_BYTES;
    }
  });

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
