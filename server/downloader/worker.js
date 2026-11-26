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
    this.bytes = 0;
    activeStore = this;
    this.closed = false;
  }
  put(index, buf, cb = () => {}) {
    if (this.closed) return cb(new Error('Store closed'));
    const previous = this.chunks.get(index);
    if (previous) this.bytes -= previous.length;
    const copy = Buffer.from(buf);
    this.chunks.set(index, copy);
    this.bytes += copy.length;
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
      if (key < minIndex) {
        const chunk = this.chunks.get(key);
        if (chunk) this.bytes -= chunk.length;
        this.chunks.delete(key);
      }
    }
  }
  close(cb = () => {}) { this.chunks.clear(); this.bytes = 0; this.closed = true; cb(null); }
  destroy(cb = () => {}) { this.close(cb); }
}

const MAX_RAM_MB = 650;
const IDLE_TIMEOUT_MS = 45000;
const PAUSE_TIMEOUT_MS = 600000;
const WINDOW_BYTES = 64 * 1024 * 1024;
const PREBUFFER_BYTES = 8 * 1024 * 1024;
const PREBUFFER_TIMEOUT_MS = 30000;
const WINDOW_UPDATE_BYTES = 1 * 1024 * 1024;
// Bound each WebTorrent FileStream selection; keep the HTTP response continuous.
const STREAM_SEGMENT_BYTES = 4 * 1024 * 1024;
// Keep this priority distinct from FileStream's priority=1 selections.
const RAM_WINDOW_PRIORITY = 2;

const client = new WebTorrent({
  maxConns: 30,
  uploadLimit: 51200,
  utp: false
});

let activeTorrent = null;
let activeFile = null;
let activeStore = null;
let pendingLoadResponse = null;
let pendingLoadTimer = null;
let activeLoadId = 0;
let isPaused = false;
let lastActivity = 0;
let activeStreams = new Set();
let diagnosticSessionId = null;
let playbackStartedAt = 0;
let lastPlaybackOffset = 0;
let streamRequestCount = 0;
let lastStreamEventAt = 0;
// The rolling window is one explicit WebTorrent selection, replaced on each shift.
let ramWindowSelection = null;

function diag(event, details = {}) {
  const stamp = new Date().toISOString();
  console.log(`[WORKER][${stamp}][${diagnosticSessionId || 'no-session'}] ${event} ${JSON.stringify(details)}`);
}

function getTorrentSelections(torrent = activeTorrent) {
  if (!torrent || !Array.isArray(torrent._selections)) return [];
  return torrent._selections.map(selection => ({
    start: selection.from,
    end: selection.to,
    offset: selection.offset,
    priority: selection.priority
  }));
}

function getDiagnostics() {
  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const storeBytes = activeStore ? activeStore.bytes : 0;
  let bufferAheadBytes = 0;
  if (activeTorrent && activeFile && activeStore && activeStore.chunks && activeTorrent.pieceLength) {
    const pieceLength = activeTorrent.pieceLength;
    const currentPiece = Math.floor((activeFile.offset + lastPlaybackOffset) / pieceLength);
    const fileEndPiece = Math.floor((activeFile.offset + activeFile.length - 1) / pieceLength);
    const maxPieces = Math.ceil(WINDOW_BYTES / pieceLength);
    for (let i = currentPiece; i <= Math.min(fileEndPiece, currentPiece + maxPieces); i++) {
      const chunk = activeStore.chunks.get(i);
      if (!chunk) break;
      bufferAheadBytes += chunk.length;
    }
  }
  return {
    timestamp: Date.now(),
    sessionId: diagnosticSessionId,
    active: !!(activeTorrent && activeFile),
    paused: isPaused,
    name: activeFile ? activeFile.name : null,
    fileSize: activeFile ? activeFile.length : 0,
    playbackOffset: lastPlaybackOffset,
    playbackSeconds: playbackStartedAt ? Math.round((Date.now() - playbackStartedAt) / 1000) : 0,
    downloadBytesPerSecond: activeTorrent ? activeTorrent.downloadSpeed : 0,
    uploadBytesPerSecond: activeTorrent ? activeTorrent.uploadSpeed : 0,
    peers: activeTorrent ? activeTorrent.numPeers : 0,
    connections: activeTorrent ? activeTorrent.numConns : 0,
    torrentProgress: activeTorrent ? activeTorrent.progress : 0,
    downloadedBytes: activeTorrent ? activeTorrent.downloaded : 0,
    uploadedBytes: activeTorrent ? activeTorrent.uploaded : 0,
    pieceLength: activeTorrent ? activeTorrent.pieceLength : 0,
    storeBytes,
    bufferAheadBytes,
    storePieces: activeStore && activeStore.chunks ? activeStore.chunks.size : 0,
    ramWindowSelection: ramWindowSelection ? { ...ramWindowSelection } : null,
    torrentSelections: getTorrentSelections(),
    activeStreams: activeStreams.size,
    streamRequestCount,
    lastStreamEventAt,
    idleForMs: lastActivity ? Date.now() - lastActivity : null,
    ramMB: rssMB
  };
}

setInterval(() => {
  if (activeTorrent) diag('METRICS', getDiagnostics());
}, 5000);

function closeAllStreams() {
  for (const s of activeStreams) {
    try { s.destroy(); } catch (e) {}
  }
  activeStreams.clear();
}

function stopAndClean(reason) {
  if (reason) {
    diag('STOP_AND_CLEAN', { reason, state: getDiagnostics() });
    console.log(`[WORKER] Oprire si eliberare RAM: ${reason}`);
  }
  closeAllStreams();
  ramWindowSelection = null;
  isPaused = false;
  lastActivity = 0;

  if (activeTorrent) {
    const t = activeTorrent;
    activeTorrent = null;
    activeFile = null;
    activeStore = null;
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

    // Keep a small rewind cushion, then release RAM for pieces already consumed.
    const keepBehindPieces = Math.ceil((8 * 1024 * 1024) / pieceLen);
    const dropUntil = currentPiece - keepBehindPieces;
    if (dropUntil > fileStartPiece && activeStore && typeof activeStore.evictBefore === 'function') {
      activeStore.evictBefore(dropUntil);
    }

    const endPriority = Math.min(fileEndPiece, currentPiece + windowPieces);

    // WebTorrent deselect() only removes an exact (start, end, priority) match.
    // Replace our previous window selection instead of accumulating selections.
    if (ramWindowSelection) {
      activeTorrent.deselect(
        ramWindowSelection.start,
        ramWindowSelection.end,
        ramWindowSelection.priority
      );
      ramWindowSelection = null;
    }

    if (endPriority >= currentPiece) {
      activeTorrent.select(currentPiece, endPriority, RAM_WINDOW_PRIORITY);
      ramWindowSelection = {
        start: currentPiece,
        end: endPriority,
        priority: RAM_WINDOW_PRIORITY
      };
    }
  } catch (e) {
    diag('RAM_WINDOW_ERROR', {
      message: e.message,
      byteOffset,
      selection: ramWindowSelection
    });
  }
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

  // Each /load owns a generation. Timers and async callbacks from an older
  // request must never be allowed to stop or answer a newer request.
  const loadId = ++activeLoadId;
  diagnosticSessionId = `${Date.now().toString(36)}-${loadId}`;
  playbackStartedAt = 0;
  lastPlaybackOffset = 0;
  streamRequestCount = 0;
  lastStreamEventAt = Date.now();
  diag('LOAD_REQUEST', { loadId, fileIdx, hasMagnet: !!magnet });
  if (pendingLoadTimer) {
    clearTimeout(pendingLoadTimer);
    pendingLoadTimer = null;
  }
  stopAndClean('Incarcare torrent nou');
  pendingLoadResponse = res;

  let responded = false;
  const isCurrentLoad = () => loadId === activeLoadId;
  const clearLoadTimer = () => {
    if (pendingLoadTimer) {
      clearTimeout(pendingLoadTimer);
      pendingLoadTimer = null;
    }
  };

  res.on('close', () => {
    if (!res.writableEnded && isCurrentLoad() && pendingLoadResponse === res) {
      responded = true;
      pendingLoadResponse = null;
      clearLoadTimer();
      stopAndClean('Clientul a anulat pregatirea');
      // Invalidate all callbacks belonging to this disconnected request.
      activeLoadId++;
    }
  });

  pendingLoadTimer = setTimeout(() => {
    if (!isCurrentLoad() || responded || pendingLoadResponse !== res) return;
    responded = true;
    pendingLoadResponse = null;
    pendingLoadTimer = null;
    stopAndClean('Timeout metadate (fara seederi)');
    if (!res.headersSent && !res.destroyed) {
      res.status(504).json({ error: 'Timeout metadate torrent' });
    }
  }, 60000);

  console.log('[WORKER] Conectare la peers in RAM...');
  const torrent = client.add(magnet, {
    store: RingMemoryStore,
    // RingMemoryStore is already RAM-backed; avoid WebTorrent's extra 20-piece cache.
    storeCacheSlots: 0,
    sequential: true
  });

  activeTorrent = torrent;

  torrent.on('error', (err) => {
    console.error('[WORKER] Eroare torrent:', err.message);
    if (!isCurrentLoad() || responded) return;
    responded = true;
    pendingLoadResponse = null;
    clearLoadTimer();
    stopAndClean('Eroare torrent');
    if (!res.headersSent && !res.destroyed) res.status(500).json({ error: err.message });
  });

  torrent.on('ready', () => {
    diag('TORRENT_READY', { files: torrent.files.length, peers: torrent.numPeers, pieceLength: torrent.pieceLength, downloaded: torrent.downloaded });
    if (!isCurrentLoad() || responded) return;
    clearLoadTimer();

    // WebTorrent 1.9.7 creates one low-priority selection for the entire torrent.
    // File.deselect() only removes a file-sized interval, so it cannot remove this
    // full-torrent selection. Remove the exact global interval before selecting RAM.
    const torrentEndPiece = torrent.pieces.length - 1;
    if (torrentEndPiece >= 0) {
      torrent.deselect(0, torrentEndPiece, false);
    }
    const remainingSelections = getTorrentSelections(torrent);
    diag('TORRENT_DEFAULT_SELECTION_REMOVED', {
      totalPieces: torrent.pieces.length,
      remainingSelections
    });

    let target = (typeof fileIdx === 'number' && torrent.files[fileIdx])
      ? torrent.files[fileIdx]
      : torrent.files.reduce((a, b) => (a.length > b.length ? a : b));

    activeFile = target;
    lastActivity = Date.now();
    isPaused = false;

    updateRamWindow(0);

    console.log(`[WORKER] Pre-buffering initial ${Math.min(target.length, PREBUFFER_BYTES) / 1024 / 1024} MB...`);
    prebufferFile(target).then((bufferedBytes) => {
      if (!isCurrentLoad() || responded || activeTorrent !== torrent) return;
      responded = true;
      pendingLoadResponse = null;
      clearLoadTimer();
      lastActivity = Date.now();
      playbackStartedAt = Date.now();
      diag('PREBUFFER_READY', { name: target.name, fileBytes: target.length, prebufferBytes: bufferedBytes, peers: torrent.numPeers, downloadBytesPerSecond: torrent.downloadSpeed });
      console.log(`[WORKER] Pregatit in RAM: ${target.name} (${Math.round(target.length / 1024 / 1024)} MB); pre-buffer: ${Math.round(bufferedBytes / 1024 / 1024)} MB`);
      if (!res.headersSent && !res.destroyed) {
        res.json({
          ready: true,
          name: target.name,
          size: target.length,
          prebufferedBytes: bufferedBytes
        });
      }
    }).catch((err) => {
      if (!isCurrentLoad() || responded) return;
      responded = true;
      pendingLoadResponse = null;
      clearLoadTimer();
      stopAndClean('Eroare la pre-buffering');
      if (!res.headersSent && !res.destroyed) {
        res.status(504).json({ error: 'Nu s-au putut pre-incarca datele torrentului' });
      }
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
    end = right === '' ? fileSize - 1 : Number(right);
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

  const file = activeFile;
  const torrent = activeTorrent;
  const range = sendStreamHeaders(req, res);
  if (!range) return;

  const { start, end } = range;
  const requestId = ++streamRequestCount;
  const streamStartedAt = Date.now();

  lastStreamEventAt = streamStartedAt;
  lastPlaybackOffset = start;
  diag('STREAM_REQUEST', {
    request: requestId,
    method: req.method,
    range: req.headers.range || null,
    start,
    end,
    requestedBytes: end - start + 1,
    segmented: true,
    segmentBytes: STREAM_SEGMENT_BYTES,
    backpressure: 'manual'
  });

  let cursor = start;
  let streamedBytes = 0;
  let nextWindowUpdate = WINDOW_UPDATE_BYTES;
  let segmentsCompleted = 0;
  let currentStream = null;
  let sessionClosed = false;
  let waitingForDrain = false;
  let segmentAdvancePending = false;
  let drainHandler = null;

  const logCleanup = (reason) => {
    diag('STREAM_CLEANUP', {
      request: requestId,
      streamedBytes,
      segmentsCompleted,
      durationMs: Date.now() - streamStartedAt,
      activeStreams: activeStreams.size,
      reason
    });
  };

  const closeSession = (reason, responseAction) => {
    if (sessionClosed) return;
    sessionClosed = true;

    if (drainHandler) {
      res.removeListener('drain', drainHandler);
      drainHandler = null;
    }

    const stream = currentStream;
    currentStream = null;
    if (stream && !stream.destroyed) {
      try { stream.destroy(); } catch (e) {}
    }

    activeStreams.delete(session);
    logCleanup(reason);

    if (responseAction === 'destroy' && !res.destroyed) {
      res.destroy();
    } else if (responseAction === 'end' && !res.destroyed && !res.writableEnded) {
      res.end();
    }
  };

  // Track the HTTP response, not each short-lived WebTorrent FileStream.
  // This stays in activeStreams across every bounded segment.
  const session = {
    destroy: () => closeSession('closed by worker lifecycle', 'destroy')
  };
  activeStreams.add(session);

  res.once('finish', () => closeSession('HTTP response finished'));
  res.once('close', () => {
    if (!res.writableFinished) closeSession('HTTP client disconnected');
    else closeSession('HTTP response closed after finish');
  });

  const onDrain = () => {
    waitingForDrain = false;
    drainHandler = null;
    if (sessionClosed) return;

    if (currentStream && !currentStream.destroyed) {
      currentStream.resume();
    } else if (segmentAdvancePending) {
      segmentAdvancePending = false;
      pumpNextSegment();
    }
  };

  function failStream(reason, err, segmentStart, segmentEnd) {
    diag('STREAM_SEGMENT_ERROR', {
      request: requestId,
      reason,
      message: err ? err.message : null,
      segmentStart,
      segmentEnd,
      streamedBytes,
      segmentsCompleted
    });
    closeSession(reason, 'destroy');
  }

  function pumpNextSegment() {
    if (sessionClosed || res.destroyed || res.writableEnded) return;

    // Do not let an old request continue against a replacement torrent.
    if (activeTorrent !== torrent || activeFile !== file || torrent.destroyed) {
      closeSession('torrent replaced while streaming', 'destroy');
      return;
    }

    if (cursor > end) {
      // Only the HTTP response ends here, after the complete requested range.
      res.end();
      return;
    }

    const segmentStart = cursor;
    const segmentEnd = Math.min(end, segmentStart + STREAM_SEGMENT_BYTES - 1);
    updateRamWindow(segmentStart);

    let stream;
    try {
      stream = file.createReadStream({ start: segmentStart, end: segmentEnd });
    } catch (err) {
      failStream('could not create WebTorrent segment', err, segmentStart, segmentEnd);
      return;
    }

    currentStream = stream;
    let segmentEnded = false;

    stream.on('data', (chunk) => {
      if (sessionClosed) return;
      if (res.destroyed || res.writableEnded) {
        closeSession('HTTP response is no longer writable');
        return;
      }

      streamedBytes += chunk.length;
      lastPlaybackOffset = start + streamedBytes;
      lastStreamEventAt = Date.now();
      lastActivity = Date.now();

      while (streamedBytes >= nextWindowUpdate) {
        updateRamWindow(Math.min(start + streamedBytes, file.length - 1));
        nextWindowUpdate += WINDOW_UPDATE_BYTES;
      }

      let canContinue;
      try {
        canContinue = res.write(chunk);
      } catch (err) {
        failStream('HTTP response write failed', err, segmentStart, segmentEnd);
        return;
      }

      if (!canContinue && !waitingForDrain) {
        waitingForDrain = true;
        stream.pause();
        drainHandler = onDrain;
        res.once('drain', drainHandler);
      }
    });

    stream.once('end', () => {
      segmentEnded = true;
    });

    stream.once('error', (err) => {
      failStream('WebTorrent FileStream error', err, segmentStart, segmentEnd);
    });

    stream.once('close', () => {
      if (sessionClosed) return;
      if (!segmentEnded) {
        diag('STREAM_SEGMENT_CLOSED_EARLY', {
          request: requestId,
          segmentStart,
          segmentEnd,
          streamedBytes,
          segmentsCompleted
        });
        closeSession('WebTorrent segment closed before end', 'destroy');
        return;
      }

      if (currentStream === stream) currentStream = null;
      cursor = segmentEnd + 1;
      segmentsCompleted++;

      // streamx Readable.pipe() always ends its destination on source end;
      // we consume data manually so the HTTP response survives segment changes.
      // Also wait for the HTTP writable to drain before opening another segment.
      if (waitingForDrain) segmentAdvancePending = true;
      else pumpNextSegment();
    });
  }

  pumpNextSegment();
});

app.post('/pause', (req, res) => {
  diag('KODI_PAUSE', getDiagnostics());
  isPaused = true;
  lastActivity = Date.now();
  closeAllStreams();
  console.log('[WORKER] Kodi -> PAUSE');
  res.json({ ok: true });
});

app.post('/resume', (req, res) => {
  diag('KODI_RESUME', getDiagnostics());
  isPaused = false;
  lastActivity = Date.now();
  console.log('[WORKER] Kodi -> RESUME');
  res.json({ ok: true });
});

app.post('/cancel', (req, res) => {
  diag('KODI_CANCEL', getDiagnostics());
  // Invalidate the current load before responding: its timeout/events become inert.
  activeLoadId++;
  if (pendingLoadTimer) {
    clearTimeout(pendingLoadTimer);
    pendingLoadTimer = null;
  }
  const pending = pendingLoadResponse;
  pendingLoadResponse = null;
  if (pending && !pending.headersSent && !pending.destroyed) {
    pending.status(499).json({ error: 'Pregatirea a fost anulata' });
  }
  stopAndClean('Cancel imediat solicitat de Kodi');
  res.json({ ok: true });
});

app.post('/stop', (req, res) => {
  diag('KODI_STOP', { reason: req.body && req.body.reason, position: req.body && req.body.position, state: getDiagnostics() });
  activeLoadId++;
  if (pendingLoadTimer) {
    clearTimeout(pendingLoadTimer);
    pendingLoadTimer = null;
  }
  const pending = pendingLoadResponse;
  pendingLoadResponse = null;
  if (pending && !pending.headersSent && !pending.destroyed) {
    pending.status(499).json({ error: 'Redarea a fost oprita' });
  }
  stopAndClean('Comanda explicita STOP de la Kodi');
  res.json({ ok: true });
});

app.get('/status', (req, res) => {
  const diagnostics = getDiagnostics();
  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  res.json({ ...diagnostics, speedKB: Math.round((diagnostics.downloadBytesPerSecond || 0) / 1024), ramMB: rssMB });
});

app.listen(4001, '127.0.0.1', () => {
  console.log('[WORKER] Ruleaza 100% in RAM pe 127.0.0.1:4001 (0 bytes pe SSD)');
});
