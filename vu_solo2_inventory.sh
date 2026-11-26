#!/bin/sh
# Read-only inventory for VU+ Solo2 / Enigma2 / BlackHole.
# Writes /tmp/vu_solo2_inventory.txt. Does not install or change packages.

OUT="/tmp/vu_solo2_inventory.txt"

{
    echo "========== DATE / UPTIME =========="
    date 2>&1
    uptime 2>&1

    echo "========== SYSTEM / IMAGE =========="
    uname -a 2>&1
    uname -m 2>&1
    cat /proc/version 2>&1
    for F in /etc/image-version /etc/issue /etc/os-release /etc/version /etc/hostname; do
        if [ -r "$F" ]; then echo "--- $F ---"; cat "$F"; fi
    done
    echo "--- CPU ---"
    cat /proc/cpuinfo 2>&1

    echo "========== PYTHON =========="
    ls -l /usr/bin/python* 2>&1
    for P in python python2 python3; do
        echo "--- $P ---"
        command -v "$P" 2>&1
        "$P" --version 2>&1
        "$P" -c 'import sys; print(sys.version); print(sys.executable); print(sys.path)' 2>&1
    done

    echo "========== ENIGMA2 PYTHON MODULE IMPORTS =========="
    if command -v python >/dev/null 2>&1; then
        python - <<'PY'
import sys
print("Python:", sys.version)
modules = [
    "enigma",
    "Screens.Screen",
    "Screens.InfoBar",
    "Screens.MoviePlayer",
    "Components.ServiceEventTracker",
    "Components.ActionMap",
    "Components.Label",
    "Components.MenuList",
    "Plugins.Plugin",
]
for name in modules:
    try:
        __import__(name)
        print("OK     ", name)
    except Exception as exc:
        print("FAILED ", name, repr(exc))
PY
    fi

    echo "========== RELEVANT INSTALLED PACKAGES =========="
    if command -v opkg >/dev/null 2>&1; then
        opkg --version 2>&1
        opkg list-installed 2>&1 | grep -Ei 'enigma2|python|gst|gstreamer|serviceapp|exteplayer|ffmpeg|openssl|curl|wget|busybox|kernel|vuplus|dreambox'
    else
        echo "opkg not found"
    fi

    echo "========== PLAYER EXECUTABLES =========="
    for X in enigma2 gst-launch gst-launch-1.0 gst-inspect gst-inspect-1.0 exteplayer3 ffmpeg curl wget openssl; do
        echo "--- $X ---"
        command -v "$X" 2>&1
    done
    ls -l /usr/bin/enigma2 2>&1
    file /usr/bin/enigma2 2>&1

    echo "========== PLAYER / GSTREAMER FILES =========="
    find /usr/lib /lib /usr/bin -iname '*serviceapp*' -o -iname '*exteplayer*' -o -iname '*gstreamer*' -o -iname 'libgst*' -o -iname '*avcodec*' -o -iname '*avformat*' -o -iname '*eplayer*' 2>/dev/null

    echo "========== ENIGMA2 PROCESS / PYTHON TREE =========="
    ps 2>&1 | grep -E '[e]nigma2'
    find /usr/lib/enigma2/python -maxdepth 3 -type f \( -name 'InfoBar.py' -o -name 'MoviePlayer.py' -o -name 'ServiceReference.py' -o -name 'Navigation.py' -o -name 'ServiceEventTracker.py' -o -name 'ActionMap.py' \) 2>/dev/null
    ls -la /usr/lib/enigma2/python/Plugins 2>&1

    echo "========== NETWORK =========="
    ifconfig -a 2>&1
    ip addr 2>&1
    route -n 2>&1
    ip route 2>&1
    cat /etc/resolv.conf 2>&1
    for X in ping nc netstat curl wget telnet; do
        echo "--- $X ---"
        command -v "$X" 2>&1
    done
    curl --version 2>&1
    wget --version 2>&1 | head -5
    openssl version 2>&1

    echo "========== MEMORY / STORAGE =========="
    free -m 2>&1
    cat /proc/meminfo 2>&1
    df -h 2>&1
    mount 2>&1
    cat /proc/loadavg 2>&1

    echo "========== SERVICES / PROCESSES =========="
    ls -la /etc/init.d 2>&1
    ps 2>&1
} > "$OUT" 2>&1

echo "Raport creat: $OUT"
wc -l "$OUT"
