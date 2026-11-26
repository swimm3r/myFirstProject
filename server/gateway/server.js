const express = require('express');
const fetch = require('node-fetch');
const http = require('http');

const app = express();
app.use(express.json());

function gatewayLog(event, details = {}) {
  console.log(`[GATEWAY][${new Date().toISOString()}] ${event} ${JSON.stringify(details)}`);
}

app.use((req, res, next) => {
  if (/^\/api\/(prepare|pause|resume|cancel|stop|status)$/.test(req.path) || req.path === '/video.mkv') {
    const started = Date.now();
    gatewayLog('HTTP_IN', { method: req.method, path: req.path, range: req.headers.range || null, client: req.ip });
    res.on('finish', () => gatewayLog('HTTP_OUT', { method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - started }));
    res.on('close', () => {
      if (!res.writableEnded) gatewayLog('HTTP_CLIENT_CLOSE', { method: req.method, path: req.path, durationMs: Date.now() - started });
    });
  }
  next();
});

process.on('uncaughtException', (err) => {
  console.error('[GATEWAY] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[GATEWAY] Unhandled Rejection:', err);
});

const WORKER_HOST = '127.0.0.1';
const WORKER_PORT = 4001;
const WORKER_URL = `http://${WORKER_HOST}:${WORKER_PORT}`;

const CINEMETA_URL = 'https://v3-cinemeta.strem.io';
const TORRENTIO_URL = 'https://torrentio.strem.fun/sort=seeders';
const OPENSUB_URL = 'https://opensubtitles-v3.strem.io';

const MAX_POSTERS = 80;
const MAX_SUBS = 30;
const MAX_HISTORY = 50;

const posterCache = new Map();
const subCache = new Map();
let watchHistory = [];

function setBoundedCache(map, key, value, maxSize) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

app.get('/api/history', (req, res) => {
  res.json(watchHistory);
});

app.post('/api/history', (req, res) => {
  const item = req.body;
  if (item && item.id) {
    watchHistory = watchHistory.filter((x) => x.id !== item.id);
    watchHistory.unshift({
      id: item.id,
      type: item.type || 'movie',
      name: item.name || 'Unknown',
      poster: item.poster || '',
      season: item.season || 0,
      episode: item.episode || 0,
      position: item.position || 0,
      updatedAt: Date.now()
    });
    if (watchHistory.length > MAX_HISTORY) {
      watchHistory = watchHistory.slice(0, MAX_HISTORY);
    }
  }
  res.json({ ok: true });
});

app.get('/api/catalog', async (req, res) => {
  try {
    const category = req.query.cat || 'movie';
    const q = (req.query.q || '').trim();

    if (/^tt\d{6,9}$/i.test(q)) {
      const imdbId = q.toLowerCase();
      for (const t of ['movie', 'series']) {
        try {
          const r = await fetchWithTimeout(`${CINEMETA_URL}/meta/${t}/${imdbId}.json`, {}, 6000);
          if (r.ok) {
            const d = await r.json();
            if (d && d.meta && d.meta.name) {
              return res.json([{
                id: d.meta.id,
                type: t,
                name: d.meta.name,
                year: d.meta.releaseInfo || '',
                imdbRating: d.meta.imdbRating || '',
                description: d.meta.description || '',
                genres: Array.isArray(d.meta.genres) ? d.meta.genres.join(', ') : '',
                poster: `/api/poster?url=${encodeURIComponent(d.meta.poster || '')}`
              }]);
            }
          }
        } catch (e) {}
      }
      return res.json([]);
    }

    let url = `${CINEMETA_URL}/catalog/movie/top.json`;
    let mediaType = 'movie';

    const themedCategories = {
      netflix: { type: 'movie', genre: 'Action' },
      hbo: { type: 'movie', genre: 'Drama' },
      disney: { type: 'movie', genre: 'Animation' },
      prime: { type: 'movie', genre: 'Sci-Fi' },
      apple: { type: 'movie', genre: 'Thriller' },
      netflix_series: { type: 'series', genre: 'Action' },
      hbo_series: { type: 'series', genre: 'Drama' },
      disney_series: { type: 'series', genre: 'Animation' },
      prime_series: { type: 'series', genre: 'Sci-Fi' },
      apple_series: { type: 'series', genre: 'Thriller' }
    };

    if (q) {
      const searchType = (category === 'series' || category.endsWith('_series')) ? 'series' : 'movie';
      mediaType = searchType;
      url = `${CINEMETA_URL}/catalog/${searchType}/top/search=${encodeURIComponent(q)}.json`;
    } else if (category === 'series') {
      mediaType = 'series';
      url = `${CINEMETA_URL}/catalog/series/top.json`;
    } else if (themedCategories[category]) {
      const config = themedCategories[category];
      mediaType = config.type;
      url = `${CINEMETA_URL}/catalog/${config.type}/top/genre=${encodeURIComponent(config.genre)}.json`;
    }

    const r = await fetchWithTimeout(url, {}, 8000);
    const data = await r.json();

    const metas = (data.metas || []).slice(0, 30).map((m) => ({
      id: m.id,
      type: m.type || mediaType,
      name: m.name || 'Unknown',
      year: m.releaseInfo || '',
      imdbRating: m.imdbRating || '',
      description: m.description || '',
      genres: Array.isArray(m.genres) ? m.genres.join(', ') : '',
      poster: `/api/poster?url=${encodeURIComponent(m.poster || '')}`
    }));

    res.json(metas);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/meta/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const r = await fetchWithTimeout(`${CINEMETA_URL}/meta/${type}/${id}.json`, {}, 8000);
    const data = await r.json();
    const meta = data.meta || {};
    const videos = Array.isArray(meta.videos) ? meta.videos.map((v) => ({
      id: v.id,
      season: v.season,
      episode: v.episode,
      title: v.title || `Episode ${v.episode}`
    })) : [];

    res.json({
      id: meta.id || id,
      name: meta.name || '',
      description: meta.description || '',
      imdbRating: meta.imdbRating || '',
      videos
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/poster', async (req, res) => {
  const imgUrl = req.query.url;
  if (!imgUrl) return res.status(404).end();

  if (posterCache.has(imgUrl)) {
    const cached = posterCache.get(imgUrl);
    res.set('Content-Type', cached.type);
    return res.send(cached.buf);
  }

  try {
    const r = await fetchWithTimeout(imgUrl, {}, 6000);
    if (!r.ok) return res.status(404).end();
    const buf = await r.buffer();
    const contentType = r.headers.get('content-type') || 'image/jpeg';
    if (buf.length > 0 && buf.length < 512 * 1024) {
      setBoundedCache(posterCache, imgUrl, { buf, type: contentType }, MAX_POSTERS);
    }
    res.set('Content-Type', contentType);
    res.send(buf);
  } catch (e) {
    res.status(404).end();
  }
});

app.get('/api/streams/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const url = `${TORRENTIO_URL}/stream/${type}/${encodeURIComponent(id)}.json`;
    const r = await fetchWithTimeout(url, {}, 10000);
    const data = await r.json();

    const seenTorrents = new Set();
    const filtered = (data.streams || [])
      .filter((s) => {
        if (!s || !s.infoHash) return false;
        const fullText = `${s.name || ''} ${s.title || ''}`.toLowerCase();
        const isTooHeavy = /2160p|4k|uhd|remux|dolby\s*vision/.test(fullText);
        return !isTooHeavy;
      })
      // Torrentio returns streams sorted by seeders; deduplicate torrent/file pairs
      // before the result limit so duplicates do not hide unique releases.
      .filter((s) => {
        const hash = String(s.infoHash).trim().toLowerCase();
        const fileIdx = (typeof s.fileIdx === 'number') ? s.fileIdx : 'auto';
        const key = `${hash}:${fileIdx}`;
        if (seenTorrents.has(key)) return false;
        seenTorrents.add(key);
        return true;
      })
      .slice(0, 20)
      .map((s) => {
        const lines = (s.title || '').split('\n');
        const mainLine = lines[0] || s.name || 'Stream';
        const rawInfoLine = lines.slice(1).join(' | ');
        // Torrentio uses emoji/symbols as metadata separators. Replace them with
        // plain-text labels so Kodi fonts without emoji support remain readable.
        const infoParts = rawInfoLine
          // Convert all Unicode symbols (including unsupported Kodi glyphs) to separators.
          .replace(/[\p{S}\uFE0F\u200D]+/gu, '|')
          // Collapse repeated separators and discard empty metadata fields.
          .split('|')
          .map((part) => part.trim())
          // Remove slash-only placeholders left behind by some Torrentio metadata.
          .filter((part) => part && !/^[/\\]+$/.test(part));
        const infoLine = infoParts.map((part) => {
          // A standalone numeric metadata field is the seed count, wherever it appears.
          // Keep arbitrary text untouched because it may be the release/file name.
          if (/^\d+$/.test(part)) return `Seeds: ${part}`;
          if (/^\d+(?:\.\d+)?\s*(?:GB|MB|TB)$/i.test(part)) return `Size: ${part}`;
          return part;
        }).join(' | ');
        return {
          name: (s.name || 'Torrent').replace(/\n/g, ' '),
          title: infoLine ? `${mainLine} (${infoLine})` : mainLine,
          infoHash: s.infoHash,
          fileIdx: (typeof s.fileIdx === 'number') ? s.fileIdx : null
        };
      });

    res.json(filtered);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/subtitles/:type/:id', async (req, res) => {
  const cacheKey = `${req.params.type}:${req.params.id}`;
  if (subCache.has(cacheKey)) {
    return res.json(subCache.get(cacheKey));
  }

  try {
    const { type, id } = req.params;
    const url = `${OPENSUB_URL}/subtitles/${type}/${encodeURIComponent(id)}.json`;
    const r = await fetchWithTimeout(url, {}, 7000);
    const data = await r.json();

    const subs = (data.subtitles || [])
      .filter((s) => s && s.url && (s.lang === 'rum' || s.lang === 'ron' || s.lang === 'eng'))
      .sort((a, b) => ((a.lang === 'rum' || a.lang === 'ron') ? -1 : 1))
      .slice(0, 8)
      .map((s) => ({
        lang: (s.lang === 'rum' || s.lang === 'ron') ? 'Romanian' : 'English',
        url: s.url
      }));

    setBoundedCache(subCache, cacheKey, subs, MAX_SUBS);
    res.json(subs);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/prepare', async (req, res) => {
  try {
    const { hash, fileIdx } = req.query;
    if (!hash) return res.status(400).json({ error: 'Lipseste hash' });

    const trackers = [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://open.stealth.si:80/announce',
      'udp://tracker.torrent.eu.org:451/announce',
      'udp://tracker.bittor.pw:1337/announce',
      'udp://exodus.desync.com:6969/announce'
    ].map((t) => `&tr=${encodeURIComponent(t)}`).join('');

    const magnet = `magnet:?xt=urn:btih:${hash}${trackers}`;

    const r = await fetchWithTimeout(`${WORKER_URL}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        magnet,
        fileIdx: (fileIdx !== undefined && fileIdx !== '' && fileIdx !== 'null') ? Number(fileIdx) : undefined
      })
    }, 125000);

    if (!r.ok) {
      const errData = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: errData.error || 'Eroare worker' });
    }

    const info = await r.json();
    const host = req.headers.host;

    res.json({
      streamUrl: `http://${host}/video.mkv`,
      fileName: info.name
    });
  } catch (e) {
    res.status(504).json({ error: 'Timeout conectare/prebuffer' });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const workerRes = await fetchWithTimeout(`${WORKER_URL}/status`, {}, 2500);
    const workerStatus = await workerRes.json();
    res.json({ gatewayTime: Date.now(), worker: workerStatus });
  } catch (e) {
    gatewayLog('STATUS_ERROR', { error: e.message });
    res.status(502).json({ error: e.message, worker: null });
  }
});

app.post('/api/pause', async (req, res) => {
  gatewayLog('KODI_PAUSE_RECEIVED');

  try {
    await fetchWithTimeout(`${WORKER_URL}/pause`, { method: 'POST' }, 3000);
  } catch (e) {}
  res.json({ ok: true });
});

app.post('/api/resume', async (req, res) => {
  gatewayLog('KODI_RESUME_RECEIVED');
  try {
    await fetchWithTimeout(`${WORKER_URL}/resume`, { method: 'POST' }, 3000);
  } catch (e) {}
  res.json({ ok: true });
});

app.post('/api/cancel', async (req, res) => {
  gatewayLog('KODI_CANCEL_RECEIVED');
  // Cancel the worker-side torrent/prebuffer request immediately.
  try {
    await fetchWithTimeout(`${WORKER_URL}/cancel`, { method: 'POST' }, 1000);
  } catch (e) {}
  res.json({ ok: true });
});

app.post('/api/stop', async (req, res) => {
  gatewayLog('KODI_STOP_RECEIVED', req.body || {});
  try {
    await fetchWithTimeout(`${WORKER_URL}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    }, 1000);
  } catch (e) {}
  res.json({ ok: true });
});

app.all('/video.mkv', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).end();
  }

  req.setTimeout(0);
  res.setTimeout(0);

  const proxyStarted = Date.now();
  let proxyBytes = 0;
  const options = {
    hostname: WORKER_HOST,
    port: WORKER_PORT,
    path: '/raw-stream',
    method: req.method,
    headers: req.headers.range ? { Range: req.headers.range } : {}
  };

  const proxyReq = http.request(options, (proxyRes) => {
    gatewayLog('STREAM_UPSTREAM_HEADERS', { status: proxyRes.statusCode, range: req.headers.range || null, contentLength: proxyRes.headers['content-length'] || null, contentRange: proxyRes.headers['content-range'] || null });
    proxyRes.on('data', chunk => { proxyBytes += chunk.length; });
    proxyRes.on('end', () => gatewayLog('STREAM_UPSTREAM_END', { bytes: proxyBytes, durationMs: Date.now() - proxyStarted }));
    proxyRes.on('aborted', () => gatewayLog('STREAM_UPSTREAM_ABORTED', { bytes: proxyBytes, durationMs: Date.now() - proxyStarted }));
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    if (req.method === 'HEAD') {
      res.end();
      proxyRes.resume();
    } else {
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    gatewayLog('STREAM_PROXY_ERROR', { error: err.message, bytes: proxyBytes, durationMs: Date.now() - proxyStarted });
    if (!res.headersSent) res.status(502).end();
    else res.end();
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      gatewayLog('STREAM_CLIENT_DISCONNECT', { bytes: proxyBytes, durationMs: Date.now() - proxyStarted });
      proxyReq.destroy();
    } else {
      gatewayLog('STREAM_CLIENT_FINISH', { bytes: proxyBytes, durationMs: Date.now() - proxyStarted });
    }
  });

  proxyReq.end();
});

app.listen(4000, '0.0.0.0', () => {
  console.log('[GATEWAY] Asculta pe portul 4000 (100% RAM mode)');
});
