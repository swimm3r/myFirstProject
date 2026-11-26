const express = require('express');
const fetch = require('node-fetch');
const http = require('http');

const app = express();
app.use(express.json());

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
const TORRENTIO_URL = 'https://torrentio.strem.fun';
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

    if (q) {
      const searchType = (category === 'series') ? 'series' : 'movie';
      mediaType = searchType;
      url = `${CINEMETA_URL}/catalog/${searchType}/top/search=${encodeURIComponent(q)}.json`;
    } else if (category === 'series') {
      mediaType = 'series';
      url = `${CINEMETA_URL}/catalog/series/top.json`;
    } else if (category === 'netflix') {
      url = `${CINEMETA_URL}/catalog/movie/top/genre=Action.json`;
    } else if (category === 'hbo') {
      url = `${CINEMETA_URL}/catalog/movie/top/genre=Drama.json`;
    } else if (category === 'disney') {
      url = `${CINEMETA_URL}/catalog/movie/top/genre=Animation.json`;
    } else if (category === 'prime') {
      url = `${CINEMETA_URL}/catalog/movie/top/genre=Sci-Fi.json`;
    } else if (category === 'apple') {
      url = `${CINEMETA_URL}/catalog/movie/top/genre=Thriller.json`;
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

    const filtered = (data.streams || [])
      .filter((s) => {
        if (!s || !s.infoHash) return false;
        const fullText = `${s.name || ''} ${s.title || ''}`.toLowerCase();
        const isTooHeavy = /2160p|4k|uhd|remux|dolby\s*vision/.test(fullText);
        return !isTooHeavy;
      })
      .slice(0, 20)
      .map((s) => {
        const lines = (s.title || '').split('\n');
        const mainLine = lines[0] || s.name || 'Stream';
        const infoLine = lines.slice(1).join(' | ');
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
    }, 38000);

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

app.post('/api/pause', async (req, res) => {
  try {
    await fetchWithTimeout(`${WORKER_URL}/pause`, { method: 'POST' }, 3000);
  } catch (e) {}
  res.json({ ok: true });
});

app.post('/api/resume', async (req, res) => {
  try {
    await fetchWithTimeout(`${WORKER_URL}/resume`, { method: 'POST' }, 3000);
  } catch (e) {}
  res.json({ ok: true });
});

app.post('/api/stop', async (req, res) => {
  try {
    await fetchWithTimeout(`${WORKER_URL}/stop`, { method: 'POST' }, 3000);
  } catch (e) {}
  res.json({ ok: true });
});

app.all('/video.mkv', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).end();
  }

  req.setTimeout(0);
  res.setTimeout(0);

  const options = {
    hostname: WORKER_HOST,
    port: WORKER_PORT,
    path: '/raw-stream',
    method: req.method,
    headers: req.headers.range ? { Range: req.headers.range } : {}
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    if (req.method === 'HEAD') {
      res.end();
      proxyRes.resume();
    } else {
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) res.status(502).end();
    else res.end();
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      proxyReq.destroy();
    }
  });

  proxyReq.end();
});

app.listen(4000, '0.0.0.0', () => {
  console.log('[GATEWAY] Asculta pe portul 4000 (100% RAM mode)');
});
