#!/usr/bin/env python3
"""GPS Tracker - reads serial GPS data and plots on an interactive map."""

import argparse
import json
import re
import signal
import sys
import threading
import time
from collections import deque
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

import serial

# Data format from sensor:
# HH:MM:SS.mmm > fix, flags, lat, lon, alt, rssi, sats
LINE_RE = re.compile(
    r"(\d{2}:\d{2}:\d{2}\.\d{3})\s*>\s*"
    r"(\d+),\s*([0-9a-fA-F]+),\s*"
    r"([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*"
    r"([-\d]+),\s*(\d+)"
)

MAP_HTML = Path(__file__).parent / "map.html"


class GPSTracker:
    def __init__(self, port, baud=115200):
        self.port = port
        self.baud = baud
        self.points = deque(maxlen=10000)
        self.serial = None
        self.running = False
        self.lock = threading.Lock()

    def connect(self):
        self.serial = serial.Serial(self.port, self.baud, timeout=1)
        self.running = True
        print(f"Connected to {self.port} @ {self.baud}")

    def disconnect(self):
        self.running = False
        if self.serial and self.serial.is_open:
            self.serial.close()
            print("Serial disconnected")

    def _read_loop(self):
        """Background thread: read serial lines and parse GPS data."""
        buf = b""
        while self.running:
            try:
                data = self.serial.read(self.serial.in_waiting or 1)
                if not data:
                    continue
                buf += data
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    self._parse_line(line.decode("utf-8", errors="replace"))
            except (serial.SerialException, OSError) as e:
                print(f"Serial error: {e}")
                time.sleep(1)
                try:
                    self.serial.open()
                except Exception:
                    pass

    def _parse_line(self, raw):
        m = LINE_RE.search(raw)
        if not m:
            return
        timestamp, fix, flags, lat, lon, alt, rssi, sats = m.groups()
        lat, lon, alt = float(lat), float(lon), float(alt)
        sats = int(sats)
        rssi = int(rssi)

        if lat == 0.0 and lon == 0.0:
            return  # skip invalid fix

        with self.lock:
            self.points.append({
                "lat": lat,
                "lon": lon,
                "alt": alt,
                "rssi": rssi,
                "sats": sats,
                "time": timestamp,
            })

        n = len(self.points)
        print(f"[{timestamp}] #{n}  {lat:.6f}, {lon:.6f}  alt={alt:.1f}  sats={sats}  rssi={rssi}")

    def start(self):
        t = threading.Thread(target=self._read_loop, daemon=True)
        t.start()

    def get_points(self):
        with self.lock:
            return list(self.points)

    def save_kml(self, path="track.kml"):
        points = self.get_points()
        coords = "\n".join(f"            {p['lon']},{p['lat']},{p['alt']}" for p in points)
        kml = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>GPS Track</name>
    <Style id="track">
      <LineStyle><color>ff0000ff</color><width>3</width></LineStyle>
    </Style>
    <Placemark>
      <name>Track</name>
      <styleUrl>#track</styleUrl>
      <LineString>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>
{coords}
        </coordinates>
      </LineString>
    </Placemark>
    {chr(10).join(
        f'    <Placemark><name>{p["time"]}</name><Point><coordinates>{p["lon"]},{p["lat"]},{p["alt"]}</coordinates></Point></Placemark>'
        for p in points
    )}
  </Document>
</kml>"""
        Path(path).write_text(kml)
        print(f"KML saved to {path}")


MAP_PAGE = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>GPS Tracker</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: monospace; background: #1a1a2e; color: #eee; }
  #header {
    padding: 8px 16px; background: #16213e; border-bottom: 1px solid #0f3460;
    display: flex; justify-content: space-between; align-items: center;
  }
  #header h1 { font-size: 14px; color: #e94560; }
  #stats { font-size: 12px; color: #aaa; }
  #map { height: calc(100vh - 40px); width: 100%; }
  .info-popup { font-family: monospace; font-size: 12px; }
</style>
</head>
<body>
<div id="header">
  <h1>GPS Tracker</h1>
  <div id="stats">Connecting...</div>
</div>
<div id="map"></div>
<script>
const map = L.map('map').setView([55.87, -4.29], 15);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap'
}).addTo(map);

const track = L.polyline([], {color: '#e94560', weight: 3}).addTo(map);
let marker = null;
let first = true;

function update() {
  fetch('/api/points')
    .then(r => r.json())
    .then(data => {
      if (!data.points.length) {
        document.getElementById('stats').textContent = 'Waiting for GPS fix...';
        return;
      }
      const pts = data.points.map(p => [p.lat, p.lon]);
      track.setLatLngs(pts);

      const last = data.points[data.points.length - 1];
      if (marker) marker.setLatLng([last.lat, last.lon]);
      else marker = L.marker([last.lat, last.lon]).addTo(map);

      marker.bindPopup(
        `<div class="info-popup">` +
        `<b>${last.time}</b><br>` +
        `Lat: ${last.lat.toFixed(6)}<br>` +
        `Lon: ${last.lon.toFixed(6)}<br>` +
        `Alt: ${last.alt.toFixed(1)}m<br>` +
        `Sats: ${last.sats}<br>` +
        `RSSI: ${last.rssi} dBm</div>`
      ).openPopup();

      if (first) {
        map.setView([last.lat, last.lon], 16);
        first = false;
      }

      document.getElementById('stats').textContent =
        `Points: ${data.points.length} | ` +
        `Lat: ${last.lat.toFixed(6)} | Lon: ${last.lon.toFixed(6)} | ` +
        `Sats: ${last.sats} | RSSI: ${last.rssi} dBm`;
    })
    .catch(() => {
      document.getElementById('stats').textContent = 'Connection lost...';
    });
}

update();
setInterval(update, 1000);
</script>
</body>
</html>"""


def make_handler(tracker):
    class Handler(SimpleHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/" or self.path == "/index.html":
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(MAP_PAGE.encode())
            elif self.path == "/api/points":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "points": tracker.get_points()
                }).encode())
            else:
                self.send_error(404)

        def log_message(self, fmt, *args):
            pass  # silence request logs

    return Handler


def main():
    parser = argparse.ArgumentParser(description="GPS Serial Tracker")
    parser.add_argument("-p", "--port", default="/dev/cu.usbmodem3665388B32321",
                        help="Serial port (default: /dev/cu.usbmodem3665388B32321)")
    parser.add_argument("-b", "--baud", type=int, default=115200,
                        help="Baud rate (default: 115200)")
    parser.add_argument("--port-num", type=int, default=8080,
                        help="Web server port (default: 8080)")
    parser.add_argument("--kml", default=None,
                        help="Save KML file on exit")
    args = parser.parse_args()

    tracker = GPSTracker(args.port, args.baud)

    def shutdown(sig, frame):
        print("\nShutting down...")
        tracker.disconnect()
        if args.kml:
            tracker.save_kml(args.kml)
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    tracker.connect()
    tracker.start()

    server = HTTPServer(("0.0.0.0", args.port_num), make_handler(tracker))
    print(f"Map: http://localhost:{args.port_num}")
    print("Waiting for GPS data...\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        tracker.disconnect()
        if args.kml:
            tracker.save_kml(args.kml)


if __name__ == "__main__":
    main()
