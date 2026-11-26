# -*- coding: utf-8 -*-
"""Small Python 2.7-compatible client for the existing TorrentioTV gateway."""

import json
import os
import urllib2
import urlparse

CONFIG_PATH = '/etc/enigma2/torrentiotv.conf'


def normalize_base_url(value):
    value = (value or '').strip().rstrip('/')
    if not value:
        raise ValueError('Gateway URL is not configured')
    parsed = urlparse.urlparse(value)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        raise ValueError('Use a full URL, for example http://192.168.1.20:4000')
    return value


def load_base_url():
    try:
        handle = open(CONFIG_PATH, 'r')
        try:
            return normalize_base_url(handle.readline())
        finally:
            handle.close()
    except IOError:
        return None


def save_base_url(value):
    value = normalize_base_url(value)
    handle = open(CONFIG_PATH, 'w')
    try:
        handle.write(value + '\n')
    finally:
        handle.close()
    return value


class GatewayClient(object):
    def __init__(self, base_url):
        self.base_url = normalize_base_url(base_url)

    def get_json(self, path, timeout=5):
        url = self.base_url + path
        request = urllib2.Request(url, headers={
            'Accept': 'application/json',
            'User-Agent': 'TorrentioTV-Enigma2/0.1'
        })
        response = urllib2.urlopen(request, timeout=timeout)
        try:
            payload = response.read()
        finally:
            response.close()
        return json.loads(payload)

    def get_status_summary(self):
        data = self.get_json('/api/status', timeout=4)
        worker = data.get('worker') or {}
        return {
            'gateway': 'OK',
            'worker': 'OK' if worker else 'No worker status',
            'session': worker.get('sessionId') or worker.get('activeTorrent') or 'idle',
            'peers': worker.get('peers', 0),
            'active_streams': worker.get('activeStreams', 0)
        }
