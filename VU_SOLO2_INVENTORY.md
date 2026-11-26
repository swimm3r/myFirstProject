# Inventar tehnic VU+ Solo2 / BlackHole 3.1.0.I

Scop: colectarea informatiilor necesare pentru dezvoltarea clientului Enigma2 TorrentioTV. Comenzile sunt de inspectie; nu instaleaza, dezinstaleaza sau modifica pachete/configuratii.

## Receiver tinta confirmat
- VU+ Solo2
- OE 3.0
- BlackHole 3.1.0.I (2021-10-01-master)
- Kernel 3.13.5 / drivers 20190429.r0

## 1. Ruleaza inventarul principal

Conecteaza-te prin SSH ca root (sau ca utilizator cu acces la informatiile sistemului):

```sh
ssh root@IP_RECEIVER
```

Descarca scriptul din repository dupa ce acest PR este integrat in main:

```sh
wget -O /tmp/vu_solo2_inventory.sh https://raw.githubusercontent.com/swimm3r/myFirstProject/main/vu_solo2_inventory.sh
sh /tmp/vu_solo2_inventory.sh
```

Scriptul scrie raportul in `/tmp/vu_solo2_inventory.txt`. Copiaza-l pe calculator:

```sh
scp root@IP_RECEIVER:/tmp/vu_solo2_inventory.txt .
```

Daca PR-ul nu este inca integrat, copiaza scriptul din branch-ul PR sau ruleaza-l dupa ce il descarci din pagina branch-ului.

## 2. Ce colecteaza scriptul

- Model/arhitectura CPU, kernel, imagine si versiuni de sistem.
- Versiunile Python disponibile, executabilele si `sys.path`.
- Importabilitatea modulelor Enigma2 folosite de un plugin nativ.
- Pachetele relevante: Enigma2, Python, GStreamer, ServiceApp, exteplayer3, FFmpeg, TLS si utilitare HTTP.
- Executabilele playerului si fisierele/bibliotecile GStreamer, codec si player.
- Procesele Enigma2, modulele si pluginurile instalate.
- Interfetele, rutele, DNS, instrumentele de retea si versiunile curl/wget/OpenSSL.
- RAM, filesystem, mount-uri si load average.

## 3. Test HTTP catre gateway

Dupa ce gateway-ul TorrentioTV ruleaza pe serverul din LAN, inlocuieste `IP_SERVER` cu IP-ul lui:

```sh
ping -c 3 IP_SERVER
wget -S -O /dev/null http://IP_SERVER:4000/api/status 2>&1
```

Pastreaza gateway-ul numai in reteaua locala de incredere; API-ul existent nu are autentificare.

## 4. Test HTTP Range pe un flux real

Acest test se face numai dupa ce gateway-ul a pregatit un torrent si ai URL-ul real al fluxului `/video.mkv`. Inlocuieste `URL_VIDEO_VALID`:

```sh
wget -S -O /dev/null --header="Range: bytes=0-1023" "URL_VIDEO_VALID"
```

Rezultatul asteptat pentru suport Range este `206 Partial Content` si un header `Content-Range`. Un `200 OK` necesita investigatie, dar singur nu demonstreaza ca seek-ul nativ nu functioneaza.

## 5. Teste care necesita playerul Enigma2

Acestea nu pot fi demonstrate doar din inventarul software. Pe receiver, folosind playerul nativ, trebuie testate:
1. Redarea unui URL HTTP mic de pe LAN.
2. Redarea unui flux real TorrentioTV.
3. Seek inainte si inapoi; verificam in logurile gateway/worker headerele Range si raspunsurile 206.
4. Pause, resume, stop, finalizare si callback-urile de eroare.
5. Redare continua si trecerea peste limitele segmentelor HTTP.

Nu instala ServiceApp/exteplayer3 sau alte pachete pentru acest inventar. Mai intai identificam ce exista deja. Nu instala Node.js/WebTorrent pe Solo2: receiverul trebuie sa ramana un client Enigma2 subtire, iar motorul si bufferul RAM raman pe backend.

## 6. Ce trimiti inapoi

Trimite:
- `vu_solo2_inventory.txt`;
- rezultatul testului gateway si Range, dupa ce exista un flux real;
- ulterior, observatiile/testul playerului pentru seek, pause/resume si stop.

Inainte de trimitere, elimina parole, tokenuri, chei private sau alte credențiale daca apar accidental in output. Poti masca IP-urile locale, dar pastreaza distinctia dintre IP_RECEIVER si IP_SERVER.

## Criteriul tehnic

Nu alegem API-ul final de player si nici compatibilitatea Python pana nu vedem versiunea reala Python, modulele Enigma2 si comportamentul HTTP Range/seek al playerului de pe acest BlackHole. Kodi si Enigma2 vor folosi acelasi gateway si acelasi WebTorrent worker; nu cream un al doilea motor sau un al doilea cache de torrent pe receiver.
