import sys
import os
import json
import time
import urllib.request
import urllib.parse
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


def show_streams(media_type, stream_id, name, poster, season=0, episode=0, base_id=''):
    server = get_server_url()
    streams = http_get_json(f'{server}/api/streams/{media_type}/{urllib.parse.quote(stream_id)}', timeout=10)
    if not streams:
        xbmcgui.Dialog().notification('TorrentioTV', 'No 1080p/720p streams found', xbmcgui.NOTIFICATION_WARNING, 3000)
        xbmcplugin.endOfDirectory(HANDLE)
        return

    for s in streams:
        label = f"[{s.get('name', 'Torrent')}] {s.get('title', '')}"
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


class TorrentioPlayer(xbmc.Player):
    def __init__(self, server_url, history_payload):
        super().__init__()
        self.server_url = server_url
        self.history_payload = history_payload
        self.stopped = False
        self.last_pos = 0

    def onPlayBackPaused(self):
        http_post_json(f'{self.server_url}/api/pause', timeout=2)

    def onPlayBackResumed(self):
        http_post_json(f'{self.server_url}/api/resume', timeout=2)

    def onPlayBackStopped(self):
        self._notify_stop()

    def onPlayBackEnded(self):
        self._notify_stop()

    def onPlayBackError(self):
        self._notify_stop()

    def _notify_stop(self):
        if self.stopped:
            return
        self.stopped = True
        http_post_json(f'{self.server_url}/api/stop', timeout=2)
        self.history_payload['position'] = int(self.last_pos)
        http_post_json(f'{self.server_url}/api/history', self.history_payload, timeout=2)


def play_stream(params):
    server = get_server_url()
    info_hash = params.get('hash', '')
    file_idx = params.get('fileIdx', '')
    media_type = params.get('type', 'movie')
    stream_id = params.get('id', '')

    prog = xbmcgui.DialogProgress()
    prog.create('TorrentioTV', 'Pre-buffering 24MB in RAM (0 SSD write)...')

    prep_url = f'{server}/api/prepare?hash={urllib.parse.quote(info_hash)}'
    if file_idx != '':
        prep_url += f'&fileIdx={urllib.parse.quote(file_idx)}'

    res = http_get_json(prep_url, timeout=130)
    prog.close()

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

    wait_start = time.time()
    while not player.isPlaying() and (time.time() - wait_start) < 15:
        if monitor.waitForAbort(0.5):
            break

    while player.isPlaying() and not monitor.abortRequested():
        try:
            player.last_pos = player.getTime()
        except Exception:
            pass
        if monitor.waitForAbort(1.0):
            break

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
