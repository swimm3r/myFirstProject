# -*- coding: utf-8 -*-
"""TorrentioTV native Enigma2 entry point.

This first milestone is deliberately diagnostic-only: it does not prepare or
start torrents and does not modify the shared gateway/worker or Kodi client.
"""

import threading
import Queue

from enigma import eTimer
from Screens.Screen import Screen
from Screens.VirtualKeyBoard import VirtualKeyBoard
from Components.ActionMap import ActionMap
from Components.Label import Label
from Components.MenuList import MenuList
from Plugins.Plugin import PluginDescriptor

from .api import GatewayClient, load_base_url, save_base_url


class TorrentioTVScreen(Screen):
    skin = """
    <screen name="TorrentioTVScreen" position="center,center" size="900,520"
        title="TorrentioTV" backgroundColor="#101820">
        <widget name="menu" position="30,35" size="840,250"
            itemHeight="48" scrollbarMode="showOnDemand" />
        <widget name="status" position="35,330" size="830,130"
            font="Regular;24" valign="top" />
    </screen>
    """

    def __init__(self, session):
        Screen.__init__(self, session)
        self.setTitle('TorrentioTV - Enigma2')
        self.base_url = load_base_url()
        self.result_queue = Queue.Queue()
        self.check_timer = eTimer()
        self.check_timer.callback.append(self._poll_result)

        self['menu'] = MenuList([
            ('Check Gateway / Worker', 'check'),
            ('Configure Gateway URL', 'configure'),
            ('Exit', 'exit')
        ])
        self['status'] = Label(
            'Gateway: not configured\n'
            'Configure the LAN URL of the existing TorrentioTV Gateway.'
            if not self.base_url else
            'Gateway: ' + self.base_url + '\n'
            'Choose "Check Gateway / Worker" to test connectivity.'
        )
        self['actions'] = ActionMap(
            ['OkCancelActions', 'DirectionActions'],
            {
                'ok': self._on_ok,
                'cancel': self.close,
                'up': self['menu'].up,
                'down': self['menu'].down
            }, -1
        )

    def _on_ok(self):
        current = self['menu'].getCurrent()
        if not current:
            return
        action = current[1]
        if action == 'check':
            self._check_gateway()
        elif action == 'configure':
            self.session.openWithCallback(
                self._save_gateway,
                VirtualKeyBoard,
                title='TorrentioTV Gateway URL',
                text=self.base_url or 'http://'
            )
        else:
            self.close()

    def _save_gateway(self, value):
        if not value:
            return
        try:
            self.base_url = save_base_url(value)
            self['status'].setText(
                'Gateway saved: ' + self.base_url + '\n'
                'Choose "Check Gateway / Worker" to test connectivity.'
            )
        except Exception as error:
            self['status'].setText('Invalid Gateway URL: ' + str(error))

    def _check_gateway(self):
        if not self.base_url:
            self['status'].setText('Configure the Gateway URL first.')
            return
        self['status'].setText('Checking Gateway and Worker...')

        def request():
            try:
                client = GatewayClient(self.base_url)
                result = client.get_status_summary()
                self.result_queue.put((True, result))
            except Exception as error:
                self.result_queue.put((False, str(error)))

        thread = threading.Thread(target=request)
        thread.setDaemon(True)
        thread.start()
        self.check_timer.start(200, False)

    def _poll_result(self):
        try:
            success, result = self.result_queue.get_nowait()
        except Queue.Empty:
            self.check_timer.start(200, False)
            return

        if not success:
            self['status'].setText('Gateway check failed:\n' + str(result))
            return

        self['status'].setText(
            'Gateway: ' + result.get('gateway', '?') +
            '    Worker: ' + result.get('worker', '?') + '\n' +
            'Session: ' + str(result.get('session', 'idle')) +
            '    Peers: ' + str(result.get('peers', 0)) +
            '    Active streams: ' + str(result.get('active_streams', 0)) +
            '\nDiagnostic only - no torrent was started.'
        )


def main(session, **kwargs):
    session.open(TorrentioTVScreen)


def Plugins(**kwargs):
    return [
        PluginDescriptor(
            name='TorrentioTV',
            description='Shared TorrentioTV gateway client',
            where=PluginDescriptor.WHERE_PLUGINMENU,
            fnc=main
        )
    ]
