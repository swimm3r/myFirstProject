import sys
import os
import json
import time
import threading
import queue
import urllib.request
import urllib.parse
import re
import xbmc
import xbmcgui
import xbmcplugin
import xbmcaddon
import xbmcvfs

ADDON = xbmcaddon.Addon()
HANDLE = int(sys.argv[1])
BASE_URL = sys.argv[0]


def get_server_url():
    ip = ADDON.getSetting('rpi_ip').strip()
    if not ip:
        ip = '127.0.0.1'
    if not ip.startswith('http'):
        ip = 'http://' + ip
    if ':' not in ip.replace('http://', ''):
        ip = ip + ':4000'
    return ip.rstrip('/')


def http_get_json(url, timeout=6):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Kodi-TorrentioTV/2.1'})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        xbmc.log(f'[TorrentioTV] GET error ({url}): {e}', xbmc.LOGWARNING)
        return None


def http_post_json(url, payload=None, timeout=3):
    try:
        data = json.dumps(payload or {}).encode('utf-8')
        req = urllib.request.Request(
            url,
            data=data,
            headers={'Content-Type': 'application/json', 'User-Agent': 'Kodi-TorrentioTV/2.1'},
            method='POST'
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except Exception:
        return None


def prepare_with_cancel(url, server_url, progress):
    """Run prepare in the background so Kodi's Cancel button stays responsive."""
    result_queue = queue.Queue(maxsize=1)

    def request_prepare():
        result_queue.put(http_get_json(url, timeout=130))

    threading.Thread(target=request_prepare, daemon=True).start()
    while True:
        if progress.iscanceled():
            # Do not make the UI wait for the cancel HTTP round-trip.
            threading.Thread(
                target=http_post_json,
                args=(f'{server_url}/api/cancel',),
                kwargs={'timeout': 1},
                daemon=True
            ).start()
            return None, True
        try:
            return result_queue.get(timeout=0.2), False
        except queue.Empty:
            progress.update(0, 'Connecting to peers and maintaining the RAM buffer...')



def download_subtitle(sub_url):
    if not sub_url:
        return None
    try:
        req = urllib.request.Request(sub_url, headers={'User-Agent': 'Kodi-TorrentioTV/2.1'})
        with urllib.request.urlopen(req, timeout=4) as resp:
            content = resp.read(524288)
            if len(content) < 50:
                return None
            temp_dir = xbmcvfs.translatePath('special://temp/')
            sub_path = os.path.join(temp_dir, 'torrentiotv_sub.srt')
            with open(sub_path, 'wb') as f:
                f.write(content)
            return sub_path
    except Exception:
        return None


def build_url(query):
    return BASE_URL + '?' + urllib.parse.urlencode(query)


def main_menu():
    items = [
        ('Continue Watching', {'action': 'history'}),
        ('Popular Movies', {'action': 'catalog', 'cat': 'movie'}),
        ('Popular Series', {'action': 'catalog', 'cat': 'series'}),
        ('Netflix (Action)', {'action': 'catalog', 'cat': 'netflix'}),
        ('HBO / Max (Drama)', {'action': 'catalog', 'cat': 'hbo'}),
        ('Disney+ (Animation)', {'action': 'catalog', 'cat': 'disney'}),
        ('Prime Video (Sci-Fi)', {'action': 'catalog', 'cat': 'prime'}),
        ('Apple TV+ (Thriller)', {'action': 'catalog', 'cat': 'apple'}),
        ('Search (Name or IMDb ID)', {'action': 'search'}),
        ('Settings (Set Server IP)', {'action': 'settings'})
    ]
    for label, params in items:
        li = xbmcgui.ListItem(label=label)
        xbmcplugin.addDirectoryItem(handle=HANDLE, url=build_url(params), listitem=li, isFolder=True)
    xbmcplugin.endOfDirectory(HANDLE)


def show_history():
    server = get_server_url()
    data = http_get_json(f'{server}/api/history', timeout=5)
    if not data:
        xbmcgui.Dialog().notification('TorrentioTV', 'No watch history yet', xbmcgui.NOTIFICATION_INFO, 2500)
        xbmcplugin.endOfDirectory(HANDLE)
        return

    for item in data:
        m_id = item.get('id', '')
        m_type = item.get('type', 'movie')
        name = item.get('name', 'Unknown')
        season = item.get('season', 0)
        episode = item.get('episode', 0)
        poster = item.get('poster', '')
        if poster.startswith('/'):
            poster = server + poster

        label = f"{name} (S{season}E{episode})" if (m_type == 'series' and season and episode) else name
        li = xbmcgui.ListItem(label=label)
        li.setArt({'poster': poster, 'thumb': poster})

        if m_type == 'series' and season and episode:
            stream_id = f"{m_id}:{season}:{episode}"
            url = build_url({'action': 'streams', 'type': 'series', 'id': stream_id, 'name': name, 'poster': poster, 'season': season, 'episode': episode, 'base_id': m_id})
        else:
            url = build_url({'action': 'streams', 'type': 'movie', 'id': m_id, 'name': name, 'poster': poster, 'base_id': m_id})

        xbmcplugin.addDirectoryItem(handle=HANDLE, url=url, listitem=li, isFolder=True)
    xbmcplugin.endOfDirectory(HANDLE)


def show_catalog(cat='movie', query=''):
    server = get_server_url()
    url = f'{server}/api/catalog?cat={urllib.parse.quote(cat)}'
    if query:
        url += f'&q={urllib.parse.quote(query)}'

    items = http_get_json(url, timeout=8)
    if not items:
        xbmcgui.Dialog().notification('TorrentioTV', 'No results or server unreachable', xbmcgui.NOTIFICATION_WARNING, 3000)
        xbmcplugin.endOfDirectory(HANDLE)
        return

    for m in items:
        m_id = m.get('id', '')
        m_type = m.get('type', 'movie')
        name = m.get('name', 'Unknown')
        year = m.get('year', '')
        rating = m.get('imdbRating', '')
        desc = m.get('description', '')
        poster = m.get('poster', '')
        if poster.startswith('/'):
            poster = server + poster

        label = f"{name} ({year})" if year else name
        if rating:
            label += f" [IMDb {rating}]"

        li = xbmcgui.ListItem(label=label)
        li.setArt({'poster': poster, 'thumb': poster})
        li.setInfo('video', {'title': name, 'plot': desc, 'year': int(year[:4]) if year[:4].isdigit() else 0})

        if m_type == 'series':
            next_url = build_url({'action': 'episodes', 'id': m_id, 'name': name, 'poster': poster})
        else:
            next_url = build_url({'action': 'streams', 'type': 'movie', 'id': m_id, 'name': name, 'poster': poster, 'base_id': m_id})

        xbmcplugin.addDirectoryItem(handle=HANDLE, url=next_url, listitem=li, isFolder=True)
    xbmcplugin.endOfDirectory(HANDLE)


def show_episodes(series_id, name, poster):
    server = get_server_url()
    meta = http_get_json(f'{server}/api/meta/series/{urllib.parse.quote(series_id)}', timeout=8)
    videos = (meta or {}).get('videos', [])
    if not videos:
        xbmcgui.Dialog().notification('TorrentioTV', 'No episodes found', xbmcgui.NOTIFICATION_INFO, 2500)
        xbmcplugin.endOfDirectory(HANDLE)
        return

    for v in videos:
        s = v.get('season', 0)
        e = v.get('episode', 0)
        if s == 0:
            continue
        ep_title = v.get('title', f'Episode {e}')
        label = f"S{s:02d}E{e:02d} - {ep_title}"
        li = xbmcgui.ListItem(label=label)
        li.setArt({'poster': poster, 'thumb': poster})
        ep_id = f"{series_id}:{s}:{e}"
        url = build_url({
            'action': 'streams',
            'type': 'series',
            'id': ep_id,
            'name': name,
            'poster': poster,
            'season': s,
            'episode': e,
            'base_id': series_id
        })
        xbmcplugin.addDirectoryItem(handle=HANDLE, url=url, listitem=li, isFolder=True)
    xbmcplugin.endOfDirectory(HANDLE)


def format_stream_label(stream):
    """Build a readable label from Torrentio's release text without guessing missing specs."""
    source = re.sub(r'\\s+', ' ', str(stream.get('name') or 'Torrent')).strip()
    raw_title = str(stream.get('title') or '').replace('\\r', '\\n')
    lines = [re.sub(r'\\s+', ' ', line).strip() for line in raw_title.split('\\n')]
    lines = [line for line in lines if line]
    release = lines[0] if lines else 'Stream'
    details = ' '.join(lines)

    specs = []
    patterns = [
        (r'(?i)(2160p|1080p|720p|576p|480p)', lambda m: m.group(1).lower()),
        (r'(?i)(?:\\bH\\.?264\\b|\\bAVC\\b|\\bx264\\b)', lambda m: 'H.264'),
        (r'(?i)(?:\\bH\\.?265\\b|\\bHEVC\\b|\\bx265\\b)', lambda m: 'H.265'),
        (r'(?i)\\bAV1\\b', lambda m: 'AV1'),
        (r'(?i)\\bVP9\\b', lambda m: 'VP9'),
        (r'(?i)\\b(?:DTS-HD\\s?MA|DTS\\s?HD\\s?MA)\\b', lambda m: 'DTS-HD MA'),
        (r'(?i)\\bTrueHD(?:\\s?Atmos)?\\b', lambda m: 'TrueHD Atmos' if 'atmos' in m.group(0).lower() else 'TrueHD'),
        (r'(?i)\\bAtmos\\b', lambda m: 'Atmos'),
        (r'(?i)\\b(?:DDP|E-AC-3|EAC3)(?:\\s?\\d\\.\\d)?\\b', lambda m: 'E-AC-3'),
        (r'(?i)\\b(?:DD|AC-3|AC3)(?:\\s?\\d\\.\\d)?\\b', lambda m: 'AC-3'),
        (r'(?i)\\bDTS(?:\\s?\\d\\.\\d)?\\b', lambda m: 'DTS'),
        (r'(?i)\\bAAC(?:\\s?\\d\\.\\d)?\\b', lambda m: 'AAC'),
        (r'(?i)\\bFLAC\\b', lambda m: 'FLAC'),
        (r'(?i)\\b(\\d+(?:[.,]\\d+)?)\\s*(GB|GiB|MB|MiB)\\b', lambda m: f"{m.group(1).replace(',', '.')} {m.group(2)}"),
    ]
    for pattern, formatter in patterns:
        match = re.search(pattern, details)
        if match:
            value = formatter(match)
            if value not in specs:
                specs.append(value)

    label = f'[{source}] {release}'
    if specs:
        label += '  |  ' + '  |  '.join(specs)
    return label


def show_streams(media_type, stream_id, name, poster, season=0, episode=0, base_id=''):
    server = get_server_url()
    streams = http_get_json(f'{server}/api/streams/{media_type}/{urllib.parse.quote(stream_id)}', timeout=10)
    if not streams:
        xbmcgui.Dialog().notification('TorrentioTV', 'No 1080p/720p streams found', xbmcgui.NOTIFICATION_WARNING, 3000)
        xbmcplugin.endOfDirectory(HANDLE)
        return

    for s in streams:
        label = format_stream_label(s)
        li = xbmcgui.ListItem(label=label)
        li.setArt({'poster': poster, 'thumb': poster})
        li.setProperty('IsPlayable', 'true')
        play_url = build_url({
            'action': 'play',
            'hash': s.get('infoHash', ''),
            'fileIdx': '' if s.get('fileIdx') is None else str(s.get('fileIdx')),
            'type': media_type,
            'id': stream_id,
            'name': name,
            'poster': poster,
            'season': season,
            'episode': episode,
            'base_id': base_id or stream_id
        })
        xbmcplugin.addDirectoryItem(handle=HANDLE, url=play_url, listitem=li, isFolder=False)
    xbmcplugin.endOfDirectory(HANDLE)


def format_rate(value):
    value = float(value or 0)
    if value >= 1024 * 1024:
        return f"{value / 1024 / 1024:.2f} MB/s"
    return f"{value / 1024:.0f} KB/s"


def sparkline(values, width=24):
    if not values:
        return '-' * width
    values = values[-width:]
    peak = max(max(values), 1)
    chars = '._-:=+*#'
    return ''.join(chars[min(len(chars) - 1, int((v / peak) * (len(chars) - 1)))] for v in values)


class TorrentioPlayer(xbmc.Player):
    def __init__(self, server_url, history_payload):
        super().__init__()
        self.server_url = server_url
        self.history_payload = history_payload
        self.stopped = False
        self.last_pos = 0
        self.stop_reason = 'unknown'

    def onPlayBackStarted(self):
        xbmc.log('[TorrentioTV][PLAYER] onPlayBackStarted', xbmc.LOGINFO)

    def onPlayBackPaused(self):
        xbmc.log('[TorrentioTV][PLAYER] onPlayBackPaused', xbmc.LOGWARNING)
        http_post_json(f'{self.server_url}/api/pause', timeout=2)

    def onPlayBackResumed(self):
        xbmc.log('[TorrentioTV][PLAYER] onPlayBackResumed', xbmc.LOGINFO)
        http_post_json(f'{self.server_url}/api/resume', timeout=2)

    def onPlayBackStopped(self):
        self.stop_reason = 'Kodi callback: stopped'
        xbmc.log('[TorrentioTV][PLAYER] onPlayBackStopped', xbmc.LOGWARNING)
        self._notify_stop()

    def onPlayBackEnded(self):
        self.stop_reason = 'Kodi callback: ended'
        xbmc.log('[TorrentioTV][PLAYER] onPlayBackEnded', xbmc.LOGINFO)
        self._notify_stop()

    def onPlayBackError(self):
        self.stop_reason = 'Kodi callback: error'
        xbmc.log('[TorrentioTV][PLAYER] onPlayBackError', xbmc.LOGERROR)
        self._notify_stop()

    def _notify_stop(self):
        if self.stopped:
            return
        self.stopped = True
        xbmc.log(f'[TorrentioTV][PLAYER] Sending STOP reason={self.stop_reason}, position={self.last_pos:.1f}s', xbmc.LOGWARNING)
        http_post_json(f'{self.server_url}/api/stop', {'reason': self.stop_reason, 'position': self.last_pos}, timeout=2)
        self.history_payload['position'] = int(self.last_pos)
        http_post_json(f'{self.server_url}/api/history', self.history_payload, timeout=2)


def play_stream(params):
    server = get_server_url()
    info_hash = params.get('hash', '')
    file_idx = params.get('fileIdx', '')
    media_type = params.get('type', 'movie')
    stream_id = params.get('id', '')

    prog = xbmcgui.DialogProgress()
    prog.create('TorrentioTV', 'Preparing stream in RAM... Cancel stops immediately.')

    prep_url = f'{server}/api/prepare?hash={urllib.parse.quote(info_hash)}'
    if file_idx != '':
        prep_url += f'&fileIdx={urllib.parse.quote(file_idx)}'

    res, was_cancelled = prepare_with_cancel(prep_url, server, prog)
    prog.close()

    if was_cancelled:
        xbmcplugin.setResolvedUrl(HANDLE, False, xbmcgui.ListItem())
        return

    if not res or not res.get('streamUrl'):
        xbmcgui.Dialog().notification('TorrentioTV', 'Failed to prebuffer peers (Timeout)', xbmcgui.NOTIFICATION_ERROR, 3500)
        xbmcplugin.setResolvedUrl(HANDLE, False, xbmcgui.ListItem())
        return

    sub_file = None
    subs = http_get_json(f'{server}/api/subtitles/{media_type}/{urllib.parse.quote(stream_id)}', timeout=5)
    if subs and len(subs) > 0:
        sub_file = download_subtitle(subs[0].get('url'))

    play_item = xbmcgui.ListItem(path=res['streamUrl'])
    if sub_file:
        play_item.setSubtitles([sub_file])

    history_payload = {
        'id': params.get('base_id', stream_id),
        'type': media_type,
        'name': params.get('name', 'Unknown'),
        'poster': params.get('poster', ''),
        'season': int(params.get('season', 0) or 0),
        'episode': int(params.get('episode', 0) or 0),
        'position': 0
    }
    http_post_json(f'{server}/api/history', history_payload, timeout=2)

    xbmcplugin.setResolvedUrl(HANDLE, True, play_item)

    player = TorrentioPlayer(server, history_payload)
    monitor = xbmc.Monitor()

    debug_display = ADDON.getSetting('debug_display') == 'true'
    diag = None
    if debug_display:
        diag = xbmcgui.DialogProgressBG()
        diag.create('TorrentioTV diagnostics', 'Waiting for playback...')
    speed_samples = []
    buffer_samples = []
    last_status_log = 0
    wait_start = time.time()
    while not player.isPlaying() and (time.time() - wait_start) < 15:
        if monitor.waitForAbort(0.5):
            break

    while player.isPlaying() and not monitor.abortRequested():
        try:
            player.last_pos = player.getTime()
        except Exception as e:
            xbmc.log(f'[TorrentioTV][PLAYER] getTime failed: {e}', xbmc.LOGDEBUG)

        status = http_get_json(f'{server}/api/status', timeout=2) or {}
        worker = status.get('worker') or {}
        speed = float(worker.get('downloadBytesPerSecond') or 0)
        store_mb = float(worker.get('bufferAheadBytes') or 0) / 1024 / 1024
        peers = worker.get('peers', 0)
        speed_samples.append(speed)
        buffer_samples.append(store_mb)
        speed_samples = speed_samples[-24:]
        buffer_samples = buffer_samples[-24:]

        if diag:
            display_parts = []
            if ADDON.getSetting('debug_show_position') == 'true':
                display_parts.append(f"Pos {player.last_pos:.0f}s")
            if ADDON.getSetting('debug_show_download') == 'true':
                display_parts.append(f"DL {format_rate(speed)}")
            if ADDON.getSetting('debug_show_upload') == 'true':
                display_parts.append(f"UL {format_rate(worker.get('uploadBytesPerSecond', 0))}")
            if ADDON.getSetting('debug_show_peers') == 'true':
                display_parts.append(f"Peers {peers}")
            if ADDON.getSetting('debug_show_ram') == 'true':
                display_parts.append(f"RAM {worker.get('ramMB', '?')}MB")
            if ADDON.getSetting('debug_show_buffer') == 'true':
                display_parts.append(f"Buffer {store_mb:.1f}MB")
            if ADDON.getSetting('debug_show_streams') == 'true':
                display_parts.append(f"Streams {worker.get('activeStreams', 0)}")
            if ADDON.getSetting('debug_show_connections') == 'true':
                display_parts.append(f"Conn {worker.get('connections', 0)}")
            if ADDON.getSetting('debug_show_download_graph') == 'true':
                display_parts.append(f"DL[{sparkline(speed_samples, 12)}]")
            if ADDON.getSetting('debug_show_buffer_graph') == 'true':
                display_parts.append(f"RAM[{sparkline(buffer_samples, 12)}]")
            if ADDON.getSetting('debug_show_offset') == 'true':
                display_parts.append(f"Offset {int(worker.get('playbackOffset', 0)) / 1024 / 1024:.1f}MB")
            if ADDON.getSetting('debug_show_idle') == 'true':
                display_parts.append(f"Idle {worker.get('idleForMs', '?')}ms")
            display_text = ' | '.join(display_parts) if display_parts else '(nimic selectat)'
            diag.update(0, 'TorrentioTV LIVE | ' + display_text)
        if time.time() - last_status_log >= 5:
            xbmc.log('[TorrentioTV][METRICS] ' + json.dumps({
                'position': player.last_pos, 'downloadBps': speed,
                'uploadBps': worker.get('uploadBytesPerSecond'), 'peers': peers,
                'storeBytes': worker.get('storeBytes'), 'bufferAheadBytes': worker.get('bufferAheadBytes'), 'ramMB': worker.get('ramMB'),
                'activeStreams': worker.get('activeStreams'), 'offset': worker.get('playbackOffset')
            }, sort_keys=True), xbmc.LOGINFO)
            last_status_log = time.time()
        if monitor.waitForAbort(1.0):
            break

    if diag:
        diag.close()
    xbmc.log(f'[TorrentioTV][PLAYER] Playback loop ended; isPlaying={player.isPlaying()}, position={player.last_pos:.1f}s', xbmc.LOGWARNING)
    player._notify_stop()


def router():
    params = dict(urllib.parse.parse_qsl(sys.argv[2][1:]))
    action = params.get('action', '')

    if action == '':
        main_menu()
    elif action == 'history':
        show_history()
    elif action == 'catalog':
        show_catalog(params.get('cat', 'movie'))
    elif action == 'search':
        kb = xbmc.Keyboard('', 'Enter movie/series name or IMDb ID (tt...)')
        kb.doModal()
        if kb.isConfirmed():
            q = kb.getText().strip()
            if q:
                show_catalog('movie', q)
            else:
                xbmcplugin.endOfDirectory(HANDLE)
        else:
            xbmcplugin.endOfDirectory(HANDLE)
    elif action == 'episodes':
        show_episodes(params.get('id', ''), params.get('name', ''), params.get('poster', ''))
    elif action == 'streams':
        show_streams(
            params.get('type', 'movie'),
            params.get('id', ''),
            params.get('name', ''),
            params.get('poster', ''),
            params.get('season', 0),
            params.get('episode', 0),
            params.get('base_id', '')
        )
    elif action == 'play':
        play_stream(params)
    elif action == 'settings':
        ADDON.openSettings()


if __name__ == '__main__':
    router()
