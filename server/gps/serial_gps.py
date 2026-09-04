"""
Rover GPS reader
================
Reads position fixes arriving over USB serial from the Arduino Uno, which in
turn reads the GPS module (see arduino/gps_bridge/gps_bridge.ino).

Accepts two line formats, so the Arduino sketch is optional:

  1. The sketch's CSV:   GPS,<lat>,<lon>,<speed_kmh>,<course_deg>,<sats>,<hdop>
                         GPS,NOFIX,<sats>
  2. Raw NMEA ($GPRMC / $GPGGA) — for a GPS module wired straight to the Pi's
     UART or an Arduino just forwarding module output.

A background thread owns the port: it reconnects every 5 s when unplugged and
keeps only the latest fix, timestamped so staleness is visible to the API.
"""

import os
import threading
import time
import logging

logger = logging.getLogger('sprout-server.gps')

try:
    import serial  # pyserial
    SERIAL_AVAILABLE = True
except ImportError:
    SERIAL_AVAILABLE = False

SERIAL_PORT = os.environ.get('GPS_SERIAL_PORT', '/dev/ttyACM0')
SERIAL_BAUD = int(os.environ.get('GPS_SERIAL_BAUD', '115200'))
RECONNECT_DELAY_S = 5
# A fix older than this is reported as no_fix — the receiver has gone quiet.
STALE_AFTER_S = 10


class SerialGPS:
    def __init__(self):
        self._lock = threading.Lock()
        self._fix = None          # dict with lat/lon/speed/heading/sats/hdop
        self._fix_time = 0.0      # monotonic time of the last good fix
        self._sats_in_view = None # satellites while still acquiring
        self._connected = False
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    # ---------- public ----------

    def snapshot(self):
        """Latest state as a JSON-ready dict for /api/gps."""
        if not SERIAL_AVAILABLE:
            return {'status': 'no_device', 'detail': 'pyserial not installed — pip install pyserial'}

        with self._lock:
            connected = self._connected
            fix = dict(self._fix) if self._fix else None
            age = time.monotonic() - self._fix_time if self._fix else None
            sats = self._sats_in_view

        if not connected:
            return {'status': 'no_device', 'detail': f'No GPS on {SERIAL_PORT}'}
        if fix is None or age is None or age > STALE_AFTER_S:
            return {'status': 'no_fix', 'sats': sats}

        return {
            'status': 'fix',
            'lat': fix['lat'],
            'lon': fix['lon'],
            'speed': fix['speed'],        # m/s
            'heading': fix['heading'],    # degrees, may be None
            'sats': fix.get('sats'),
            'hdop': fix.get('hdop'),
            # Consumer GPS with HDOP n is roughly n * 5 m of horizontal error.
            'accuracy': (fix['hdop'] * 5.0) if fix.get('hdop') else None,
            'age_s': round(age, 1),
        }

    # ---------- serial thread ----------

    def _run(self):
        if not SERIAL_AVAILABLE:
            logger.warning('pyserial not installed; rover GPS disabled')
            return
        while True:
            try:
                with serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=2) as port:
                    logger.info(f'GPS serial open on {SERIAL_PORT} @ {SERIAL_BAUD}')
                    with self._lock:
                        self._connected = True
                    for raw in port:
                        line = raw.decode('ascii', errors='ignore').strip()
                        if line:
                            self._handle_line(line)
            except (serial.SerialException, OSError) as e:
                with self._lock:
                    self._connected = False
                logger.debug(f'GPS serial unavailable ({e}); retrying in {RECONNECT_DELAY_S}s')
                time.sleep(RECONNECT_DELAY_S)

    def _handle_line(self, line):
        if line.startswith('GPS,'):
            self._parse_csv(line)
        elif line.startswith(('$GPRMC', '$GNRMC')):
            self._parse_rmc(line)
        elif line.startswith(('$GPGGA', '$GNGGA')):
            self._parse_gga(line)

    # ---------- parsers ----------

    def _store_fix(self, lat, lon, speed_ms, heading, sats=None, hdop=None):
        with self._lock:
            self._fix = {
                'lat': lat, 'lon': lon, 'speed': speed_ms,
                'heading': heading, 'sats': sats, 'hdop': hdop,
            }
            self._fix_time = time.monotonic()

    def _parse_csv(self, line):
        parts = line.split(',')
        if len(parts) >= 2 and parts[1] == 'NOFIX':
            with self._lock:
                self._sats_in_view = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else None
            return
        try:
            lat, lon = float(parts[1]), float(parts[2])
            speed_ms = float(parts[3]) / 3.6 if len(parts) > 3 else 0.0
            heading = float(parts[4]) if len(parts) > 4 and parts[4] else None
            sats = int(parts[5]) if len(parts) > 5 and parts[5].isdigit() else None
            hdop = float(parts[6]) if len(parts) > 6 and parts[6] else None
            self._store_fix(lat, lon, speed_ms, heading, sats, hdop)
        except (ValueError, IndexError):
            pass

    @staticmethod
    def _nmea_coord(value, hemisphere):
        """ddmm.mmmm / dddmm.mmmm -> signed decimal degrees."""
        if not value:
            return None
        try:
            head, minutes = value.split('.')
            deg = int(head[:-2])
            mins = float(head[-2:] + '.' + minutes)
            decimal = deg + mins / 60.0
            return -decimal if hemisphere in ('S', 'W') else decimal
        except (ValueError, IndexError):
            return None

    def _parse_rmc(self, line):
        f = line.split(',')
        # $GPRMC,time,A|V,lat,N,lon,E,speed_knots,course,...
        if len(f) < 9 or f[2] != 'A':
            return
        lat = self._nmea_coord(f[3], f[4])
        lon = self._nmea_coord(f[5], f[6])
        if lat is None or lon is None:
            return
        speed_ms = float(f[7]) * 0.514444 if f[7] else 0.0
        heading = float(f[8]) if f[8] else None
        self._store_fix(lat, lon, speed_ms, heading)

    def _parse_gga(self, line):
        f = line.split(',')
        # $GPGGA,time,lat,N,lon,E,quality,sats,hdop,...
        if len(f) < 9:
            return
        sats = int(f[7]) if f[7].isdigit() else None
        with self._lock:
            self._sats_in_view = sats
        if f[6] in ('0', ''):
            return  # no fix yet — sats-in-view already noted
        lat = self._nmea_coord(f[2], f[3])
        lon = self._nmea_coord(f[4], f[5])
        if lat is None or lon is None:
            return
        hdop = float(f[8]) if f[8] else None
        # GGA has no speed/course; RMC (interleaved by every receiver) fills
        # them in. Preserve the previous values rather than zeroing them.
        with self._lock:
            prev = self._fix or {}
        self._store_fix(lat, lon, prev.get('speed', 0.0), prev.get('heading'), sats, hdop)
