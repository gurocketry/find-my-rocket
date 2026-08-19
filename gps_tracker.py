#!/usr/bin/env python3
"""Serial GPS rocket tracker with a live 3D view and showcase simulator."""

import argparse
import json
import math
import os
import re
import signal
import sys
import threading
import time
from collections import deque
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

import serial


# Sensor format: [HH:MM:SS.mmm > ]fix, flags, lat, lon, alt, rssi, sats
LINE_RE = re.compile(
    r"(?:(\d{2}:\d{2}:\d{2}\.\d{3})\s*>\s*)?"
    r"((?:[0-4]|255)),\s*([0-9a-fA-F]+),\s*"
    r"([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*"
    r"([-\d]+),\s*(\d+?)"
    r"(?=\s*(?:(?:\d{2}:\d{2}:\d{2}\.\d{3}\s*>\s*)?"
    r"(?:[0-4]|255)\s*,\s*[0-9a-fA-F]+\s*,\s*[-\d.]+\s*,|$))"
)

TIMESTAMP_START_RE = re.compile(r"\d{2}:\d{2}:\d{2}\.\d{3}\s*>\s*")
MAX_SERIAL_BUFFER = 8192

EARTH_RADIUS_M = 6_371_000.0
GRAVITY_M_S2 = 9.80665
FLIGHT_STAGES = {
    0: "PAD",
    1: "BURNING",
    2: "COASTING",
    3: "DESCENT",
    4: "LANDED",
    255: "UNKNOWN",
}


def discover_devices():
    """Return connected serial devices, with likely USB GPS/radio devices first."""
    devices = []
    if sys.platform == "darwin":
        # pyserial's IOKit enumerator currently crashes under some Python 3.14/Nix
        # combinations, while macOS's callout device names contain what we need.
        raw_devices = [(str(path), path.name.removeprefix("cu.")) for path in Path("/dev").glob("cu.*")]
    elif sys.platform.startswith("linux"):
        paths = list(Path("/dev").glob("ttyUSB*")) + list(Path("/dev").glob("ttyACM*"))
        raw_devices = [(str(path), path.name) for path in paths]
    else:
        from serial.tools import list_ports
        raw_devices = [(item.device, item.description or "Unknown device") for item in list_ports.comports()]
    for port, description in raw_devices:
        fingerprint = f"{port} {description}".lower()
        likely = any(word in fingerprint for word in (
            "usb", "modem", "serial", "uart", "gps", "radio", "telemetry", "cp210", "ch340"
        ))
        devices.append({
            "port": port,
            "description": description,
            "hwid": "",
            "likely": likely,
        })
    return sorted(devices, key=lambda d: (not d["likely"], d["port"]))


def choose_device(devices, input_fn=input, interactive=None):
    """Choose the sole device, or ask the operator when discovery is ambiguous."""
    if not devices:
        raise RuntimeError("No serial devices found. Connect the receiver or pass --demo.")
    if len(devices) == 1:
        return devices[0]["port"]

    if interactive is None:
        interactive = sys.stdin.isatty()
    choices = "\n".join(
        f"  {index}. {device['port']} — {device['description']}"
        for index, device in enumerate(devices, 1)
    )
    if not interactive:
        raise RuntimeError(
            "Multiple serial devices found; specify one with --port:\n" + choices
        )

    print("Multiple serial devices found. Which receiver should be tracked?")
    print(choices)
    while True:
        answer = input_fn(f"Select 1-{len(devices)}: ").strip()
        try:
            selection = int(answer)
            if 1 <= selection <= len(devices):
                return devices[selection - 1]["port"]
        except ValueError:
            pass
        print("Please enter one of the listed numbers.")


def clock_seconds(value):
    hours, minutes, seconds = value.split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def offset_location(lat, lon, north_m, east_m):
    lat_out = lat + math.degrees(north_m / EARTH_RADIUS_M)
    lon_out = lon + math.degrees(east_m / (EARTH_RADIUS_M * math.cos(math.radians(lat))))
    return lat_out, lon_out


def load_local_env(path=None):
    """Read simple KEY=VALUE entries from a local .env without a dependency."""
    env_path = Path(path) if path else Path(__file__).with_name(".env")
    values = {}
    if not env_path.is_file():
        return values
    for raw_line in env_path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if value[:1] in ("'", '"') and value[-1:] == value[:1]:
            value = value[1:-1]
        values[key] = value
    return values


class GPSTracker:
    def __init__(self, port=None, baud=115200, log_path="telemetry-backup.jsonl"):
        self.port = port
        self.baud = baud
        self.log_path = Path(log_path) if log_path else None
        self._log_file = None
        self._log_lock = threading.Lock()
        self.points = deque(maxlen=10000)
        self.serial = None
        self.running = False
        self.lock = threading.Lock()
        self.launched = False
        self.launch_time = None
        self.ground_altitude = None
        self.velocity = {"north": 0.0, "east": 0.0, "vertical": 0.0, "speed": 0.0}
        self._open_log()

    def _open_log(self):
        if self.log_path is None:
            return
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            self._log_file = self.log_path.open("a", encoding="utf-8", buffering=1)
        except OSError as exc:
            print(f"Telemetry backup unavailable ({self.log_path}): {exc}", file=sys.stderr)

    def _log_point(self, point):
        """Append and durably flush one recovery record before continuing."""
        record = {
            "record": "telemetry",
            "logged_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": self.port or "simulation",
            "point": point,
        }
        self._write_log_record(record)

    def _log_rejected(self, raw, reason="malformed telemetry"):
        """Keep rejected input in the recovery journal for later inspection."""
        if not raw.strip():
            return
        self._write_log_record({
            "record": "rejected",
            "logged_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": self.port or "simulation",
            "reason": reason,
            "raw": raw[:2048],
        })

    def _write_log_record(self, record):
        try:
            with self._log_lock:
                if self._log_file is None:
                    return
                self._log_file.write(json.dumps(record, separators=(",", ":")) + "\n")
                self._log_file.flush()
                os.fsync(self._log_file.fileno())
        except (OSError, ValueError) as exc:
            print(f"Telemetry backup write failed ({self.log_path}): {exc}", file=sys.stderr)

    def close_log(self):
        if self._log_file is not None:
            with self._log_lock:
                self._log_file.flush()
                self._log_file.close()
                self._log_file = None

    def connect(self):
        if not self.port:
            raise RuntimeError("A serial port is required")
        self.serial = serial.Serial(self.port, self.baud, timeout=1)
        self.running = True
        print(f"Connected to {self.port} @ {self.baud}")

    def disconnect(self):
        self.running = False
        if self.serial and self.serial.is_open:
            self.serial.close()
            print("Serial disconnected")
        self.close_log()

    def _read_loop(self):
        buf = b""
        while self.running:
            try:
                data = self.serial.read(self.serial.in_waiting or 1)
                if not data:
                    continue
                # Accept CR, LF, or CRLF ground-station framing.
                buf += data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    self._parse_line(line.decode("utf-8", errors="replace"))
                if len(buf) > MAX_SERIAL_BUFFER:
                    # A lost delimiter must not allow an unbounded buffer to
                    # retain every later packet. Preserve only the latest
                    # plausible packet start and continue receiving.
                    text = buf.decode("utf-8", errors="replace")
                    starts = [match.start() for match in TIMESTAMP_START_RE.finditer(text)]
                    keep_from = starts[-1] if starts else max(0, len(text) - 512)
                    discarded = text[:keep_from] or text[:-512]
                    self._log_rejected(discarded, "serial buffer resynchronised")
                    print("Telemetry buffer overflow; resynchronising", file=sys.stderr)
                    buf = text[keep_from:].encode("utf-8") if starts else text[-512:].encode("utf-8")
            except (serial.SerialException, OSError) as exc:
                print(f"Serial error: {exc}")
                time.sleep(1)
                try:
                    if self.serial.is_open:
                        self.serial.close()
                    self.serial.open()
                    self.serial.reset_input_buffer()
                    buf = b""
                    print(f"Reconnected to {self.port}")
                except (serial.SerialException, OSError):
                    pass

    def _parse_line(self, raw):
        """Parse every intact Astra packet in a line, resynchronising after damage."""
        matches = list(LINE_RE.finditer(raw))
        accepted = False
        if not matches:
            self._log_rejected(raw)
            if raw.strip():
                print(f"Rejected telemetry: {raw}", file=sys.stderr)
            return False

        consumed = 0
        for match in matches:
            if match.start() > consumed:
                self._log_rejected(raw[consumed:match.start()], "discarded before packet boundary")
            candidate = match.group(0)
            consumed = match.end()
            timestamp, stage, _flags, lat, lon, alt, rssi, sats = match.groups()
            stage_value = int(stage)
            lat_value, lon_value = float(lat), float(lon)
            sats_value = int(sats)
            if (
                stage_value not in FLIGHT_STAGES
                or not -90 <= lat_value <= 90
                or not -180 <= lon_value <= 180
                or not 0 <= sats_value <= 255
            ):
                self._log_rejected(candidate, "telemetry fields out of range")
                print(f"Rejected out-of-range telemetry: {candidate}", file=sys.stderr)
                continue
            accepted = self.add_point(
                lat_value, lon_value, float(alt), int(rssi), sats_value, timestamp,
                stage=stage_value,
            ) or accepted
        if consumed < len(raw):
            self._log_rejected(raw[consumed:], "discarded after packet boundary")
        return accepted

    def add_point(self, lat, lon, alt, rssi=-70, sats=10, timestamp=None, elapsed=None, stage=None):
        """Add real or simulated telemetry and update flight state."""
        if lat == 0.0 and lon == 0.0:
            return False
        timestamp = timestamp or time.strftime("%H:%M:%S.000")
        elapsed = clock_seconds(timestamp) if elapsed is None else float(elapsed)
        point = {
            "lat": float(lat), "lon": float(lon), "alt": float(alt),
            "rssi": int(rssi), "sats": int(sats), "time": timestamp,
            "elapsed": elapsed,
        }
        if stage is not None:
            point["stage"] = int(stage)
        # Commit to the recovery journal before mutating the in-memory track.
        self._log_point(point)
        with self.lock:
            if self.ground_altitude is None:
                self.ground_altitude = point["alt"]
            self.points.append(point)
            self._update_flight_state_locked()
            count = len(self.points)
            stage_label = (
                FLIGHT_STAGES.get(stage, f"UNKNOWN:{stage}")
                if stage is not None
                else ("FLIGHT" if self.launched else "PAD")
            )
        print(
            f"[{stage_label}] [{timestamp}] #{count}  {lat:.6f}, {lon:.6f}  "
            f"alt={alt:.1f}m  sats={sats}  rssi={rssi}"
        )
        return True

    def _update_flight_state_locked(self):
        if len(self.points) < 2:
            return
        newest = self.points[-1]
        # Use a multi-sample window to suppress single-fix GPS spikes.
        oldest = self.points[-min(5, len(self.points))]
        dt = newest["elapsed"] - oldest["elapsed"]
        if dt < 0:
            dt += 24 * 3600
        if dt <= 0:
            return
        north = math.radians(newest["lat"] - oldest["lat"]) * EARTH_RADIUS_M
        east = (
            math.radians(newest["lon"] - oldest["lon"])
            * EARTH_RADIUS_M * math.cos(math.radians(newest["lat"]))
        )
        vertical = (newest["alt"] - oldest["alt"]) / dt
        north_v, east_v = north / dt, east / dt
        self.velocity = {
            "north": north_v,
            "east": east_v,
            "vertical": vertical,
            "speed": math.sqrt(north_v ** 2 + east_v ** 2 + vertical ** 2),
        }
        altitude_gain = newest["alt"] - self.ground_altitude
        if not self.launched and len(self.points) >= 4 and altitude_gain >= 15 and vertical >= 5:
            self.launched = True
            self.launch_time = newest["time"]
            print(f"LAUNCH DETECTED at {self.launch_time}")

    def start(self):
        threading.Thread(target=self._read_loop, daemon=True).start()

    def start_simulation(self, rate=1.0):
        self.running = True
        threading.Thread(target=self._simulation_loop, args=(rate,), daemon=True).start()

    def _simulation_loop(self, rate):
        """Generate a repeatable pad-to-flight trajectory for demos."""
        origin_lat, origin_lon, ground_alt = 55.8708, -4.2898, 45.0
        start_clock = 12 * 3600
        step = 0
        while self.running and step <= 72:
            t = step * 0.5
            flight_t = max(0.0, t - 4.0)
            if t < 4.0:
                altitude = ground_alt
                north = east = 0.0
            elif flight_t <= 29.5:
                # A visually useful, deterministic showcase flight.
                altitude = ground_alt + max(0.0, 70 * flight_t - 2.4 * flight_t ** 2)
                north = 3.5 * flight_t
                east = 6.0 * flight_t
            else:
                # Hold the landed fix for a few seconds, then leave the completed
                # flight on screen instead of filling the history forever.
                altitude = ground_alt
                north = 3.5 * 29.5
                east = 6.0 * 29.5
            lat, lon = offset_location(origin_lat, origin_lon, north, east)
            seconds = start_clock + t
            hh = int(seconds // 3600) % 24
            mm = int(seconds % 3600 // 60)
            ss = seconds % 60
            stamp = f"{hh:02d}:{mm:02d}:{ss:06.3f}"
            self.add_point(lat, lon, altitude, -58 - step // 20, 12, stamp, t)
            step += 1
            time.sleep(max(0.01, 0.5 / rate))
        self.running = False
        print("Simulated flight complete; the 3D view remains available")

    def _prediction_locked(self):
        if not self.launched or not self.points:
            return []
        last = self.points[-1]
        vertical = self.velocity["vertical"]
        ground = self.ground_altitude
        prediction = []
        # Ballistic projection from current GPS-derived velocity; capped for safety/readability.
        for second in range(1, 121):
            altitude = last["alt"] + vertical * second - 0.5 * GRAVITY_M_S2 * second ** 2
            if altitude <= ground:
                if prediction:
                    prediction.append({**prediction[-1], "alt": ground, "seconds": second})
                break
            lat, lon = offset_location(
                last["lat"], last["lon"],
                self.velocity["north"] * second,
                self.velocity["east"] * second,
            )
            prediction.append({"lat": lat, "lon": lon, "alt": altitude, "seconds": second})
        return prediction

    def snapshot(self):
        with self.lock:
            points = [dict(point) for point in self.points]
            for point in points:
                point.pop("elapsed", None)
            return {
                "points": points,
                "prediction": self._prediction_locked(),
                "flight": {
                    "launched": self.launched,
                    "launch_time": self.launch_time,
                    "ground_altitude": self.ground_altitude,
                    "velocity": dict(self.velocity),
                },
            }

    def get_points(self):
        return self.snapshot()["points"]

    def save_kml(self, path="track.kml"):
        points = self.get_points()
        coords = "\n".join(f"            {p['lon']},{p['lat']},{p['alt']}" for p in points)
        kml = f'''<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Rocket GPS Track</name>
<Placemark><name>Flight path</name><Style><LineStyle><color>ff0000ff</color><width>3</width></LineStyle></Style>
<LineString><altitudeMode>absolute</altitudeMode><coordinates>
{coords}
</coordinates></LineString></Placemark></Document></kml>'''
        Path(path).write_text(kml)
        print(f"KML saved to {path}")


MAP_PAGE = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rocket Tracker 3D</title>
<script src="https://cesium.com/downloads/cesiumjs/releases/1.129/Build/Cesium/Cesium.js"></script>
<link href="https://cesium.com/downloads/cesiumjs/releases/1.129/Build/Cesium/Widgets/widgets.css" rel="stylesheet">
<style>
*{box-sizing:border-box}html,body,#globe{width:100%;height:100%;margin:0;overflow:hidden;background:#07111e}
body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#e8f1ff}
#top{position:absolute;z-index:2;left:16px;right:16px;top:14px;display:flex;justify-content:space-between;pointer-events:none}
.panel{background:rgba(5,15,28,.88);border:1px solid #264660;border-radius:8px;padding:10px 14px;box-shadow:0 6px 25px #0008}
#brand{color:#ff5576;font-weight:700;letter-spacing:.12em}#state{color:#8ca7bd;font-size:12px;margin-top:5px}
#telemetry{text-align:right;font-size:12px;line-height:1.55}.launch{color:#67f5a5}.waiting{color:#ffc857}
#user-location{color:#8ca7bd;font-size:11px;margin-top:5px}.located{color:#67d9ff}
#legend{position:absolute;z-index:2;bottom:24px;left:16px;font-size:11px}.swatch{display:inline-block;width:18px;height:3px;margin:0 7px 3px 12px}
@media(max-width:640px){#top{left:8px;right:8px;top:8px;gap:8px}.panel{padding:8px 10px}#telemetry{font-size:10px}#legend{left:8px;bottom:18px}}
</style></head><body><div id="globe"></div>
<div id="top"><div class="panel"><div id="brand">ROCKET TRACKER · 3D</div><div id="state">Waiting for telemetry…</div><div id="user-location">Device location unavailable</div></div><div id="telemetry" class="panel">No GPS fix</div></div>
<div id="legend" class="panel"><span class="swatch" style="background:#ff5576"></span>flown <span class="swatch" style="background:#42d9ff"></span>prediction <span class="swatch" style="background:#67f5a5"></span>you</div>
<script>
const CESIUM_TOKEN=__CESIUM_TOKEN__;
const terrainEnabled=Boolean(CESIUM_TOKEN);
if(terrainEnabled)Cesium.Ion.defaultAccessToken=CESIUM_TOKEN;
const viewerOptions={animation:false,timeline:false,baseLayerPicker:false,geocoder:false,homeButton:false,sceneModePicker:false,navigationHelpButton:false,infoBox:false,selectionIndicator:false};
if(terrainEnabled)viewerOptions.terrain=Cesium.Terrain.fromWorldTerrain({requestVertexNormals:true});
const viewer=new Cesium.Viewer('globe',viewerOptions);
viewer.imageryLayers.removeAll();viewer.imageryLayers.addImageryProvider(new Cesium.OpenStreetMapImageryProvider({url:'https://tile.openstreetmap.org/'}));
viewer.scene.globe.depthTestAgainstTerrain=terrainEnabled;viewer.scene.globe.enableLighting=terrainEnabled;viewer.scene.skyAtmosphere.show=true;
const flown=viewer.entities.add({polyline:{positions:[],width:4,material:Cesium.Color.fromCssColorString('#ff5576'),clampToGround:false}});
const predicted=viewer.entities.add({polyline:{positions:[],width:3,material:new Cesium.PolylineDashMaterialProperty({color:Cesium.Color.fromCssColorString('#42d9ff'),dashLength:16})}});
const rocket=viewer.entities.add({position:Cesium.Cartesian3.fromDegrees(-4.2898,55.8708,45),point:{pixelSize:13,color:Cesium.Color.WHITE,outlineColor:Cesium.Color.fromCssColorString('#ff5576'),outlineWidth:4},label:{text:'ROCKET',font:'12px monospace',pixelOffset:new Cesium.Cartesian2(0,-24),fillColor:Cesium.Color.WHITE,showBackground:true,backgroundColor:new Cesium.Color(0.02,0.06,0.11,.8)}});
const initialDevicePosition=Cesium.Cartesian3.fromDegrees(-4.2898,55.8708,0);
const deviceLocation=viewer.entities.add({show:false,position:initialDevicePosition,point:{pixelSize:11,color:Cesium.Color.fromCssColorString('#67f5a5'),outlineColor:Cesium.Color.WHITE,outlineWidth:2,heightReference:Cesium.HeightReference.CLAMP_TO_GROUND},label:{text:'YOU',font:'12px monospace',pixelOffset:new Cesium.Cartesian2(0,-22),fillColor:Cesium.Color.WHITE,showBackground:true,backgroundColor:new Cesium.Color(0.02,0.06,0.11,.8),heightReference:Cesium.HeightReference.CLAMP_TO_GROUND}});
const locationAccuracy=viewer.entities.add({show:false,position:initialDevicePosition,ellipse:{semiMinorAxis:1,semiMajorAxis:1,height:0,material:Cesium.Color.fromCssColorString('#67f5a5').withAlpha(.18),heightReference:Cesium.HeightReference.CLAMP_TO_GROUND}});
let first=true,terrainOffset=null,terrainAgl=null,visiblePrediction=[],sampling=false,lastSample=0,lastDevicePosition=null;
function distanceMetres(a,b){const from=Cesium.Cartographic.fromDegrees(a.lon,a.lat),to=Cesium.Cartographic.fromDegrees(b.lon,b.lat);return new Cesium.EllipsoidGeodesic(from,to).surfaceDistance;}
function updateDeviceLocation(position){
  const {latitude:lat,longitude:lon,accuracy}=position.coords;
  lastDevicePosition={lat,lon};
  const cartesian=Cesium.Cartesian3.fromDegrees(lon,lat,0);
  deviceLocation.position=cartesian;deviceLocation.show=true;
  locationAccuracy.position=cartesian;locationAccuracy.ellipse.semiMinorAxis=Math.max(1,accuracy);locationAccuracy.ellipse.semiMajorAxis=Math.max(1,accuracy);locationAccuracy.show=true;
  const rocketPoint=window.lastRocketPoint;
  const range=rocketPoint?` · ROCKET ${(distanceMetres(lastDevicePosition,rocketPoint)/1000).toFixed(2)} km`:'';
  document.getElementById('user-location').innerHTML=`<span class="located">● DEVICE GPS</span> · ±${Math.round(accuracy)} m${range}`;
}
function locationError(error){const messages={1:'permission denied',2:'position unavailable',3:'request timed out'};document.getElementById('user-location').textContent=`Device location ${messages[error.code]||'unavailable'}`;}
if(!window.isSecureContext)document.getElementById('user-location').textContent='Device GPS requires HTTPS';
else if('geolocation' in navigator)navigator.geolocation.watchPosition(updateDeviceLocation,locationError,{enableHighAccuracy:true,maximumAge:5000,timeout:15000});
function displayAltitude(point){return point.displayAlt??point.alt+(terrainOffset??0);}
function positions(rows){return rows.flatMap(p=>[p.lon,p.lat,displayAltitude(p)]);}
function render(data){
  const last=data.points.at(-1),flight=data.flight;
  window.lastRocketPoint=last;
  flown.polyline.positions=Cesium.Cartesian3.fromDegreesArrayHeights(positions(data.points));
  predicted.polyline.positions=Cesium.Cartesian3.fromDegreesArrayHeights(positions(visiblePrediction.length?visiblePrediction:data.prediction));
  rocket.position=Cesium.Cartesian3.fromDegrees(last.lon,last.lat,displayAltitude(last));
  const terrainText=terrainEnabled?(terrainAgl===null?' · TERRAIN LOADING':` · AGL ≈ ${terrainAgl.toFixed(1)} m`):' · FLAT TERRAIN';
  document.getElementById('state').innerHTML=flight.launched?`<span class="launch">● LAUNCH DETECTED</span> · ${flight.launch_time} · terrain-aware estimate`:`<span class="waiting">● ON PAD</span> · launch auto-detection armed`;
  document.getElementById('telemetry').innerHTML=`ALT ${last.alt.toFixed(1)} m${terrainText}<br>SPEED ${flight.velocity.speed.toFixed(1)} m/s · V/S ${flight.velocity.vertical.toFixed(1)} m/s<br>${last.lat.toFixed(6)}, ${last.lon.toFixed(6)} · ${last.sats} SAT`;
  if(lastDevicePosition){const range=distanceMetres(lastDevicePosition,last);const status=document.getElementById('user-location');status.innerHTML=status.innerHTML.replace(/ · ROCKET .*$/,` · ROCKET ${(range/1000).toFixed(2)} km`);}
  if(first){viewer.camera.flyTo({destination:Cesium.Cartesian3.fromDegrees(last.lon,last.lat,1800),orientation:{heading:0,pitch:Cesium.Math.toRadians(-50),roll:0},duration:1});first=false;}
}
async function sampleGround(data){
  if(!terrainEnabled||sampling||Date.now()-lastSample<2000)return;
  sampling=true;lastSample=Date.now();
  try{
    const firstPoint=data.points[0],last=data.points.at(-1),rows=[firstPoint,last,...data.prediction];
    const samples=rows.map(p=>Cesium.Cartographic.fromDegrees(p.lon,p.lat));
    await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider,samples);
    if(terrainOffset===null&&Number.isFinite(samples[0].height))terrainOffset=samples[0].height-data.flight.ground_altitude;
    if(terrainOffset!==null&&Number.isFinite(samples[1].height))terrainAgl=Math.max(0,last.alt+terrainOffset-samples[1].height);
    visiblePrediction=[];
    let hitGround=false;
    data.prediction.forEach((point,index)=>{
      if(hitGround)return;
      const terrainHeight=samples[index+2].height;
      const rocketHeight=point.alt+(terrainOffset??0);
      if(Number.isFinite(terrainHeight)&&rocketHeight<=terrainHeight){
        visiblePrediction.push({...point,displayAlt:terrainHeight});
        hitGround=true;
      }else visiblePrediction.push(point);
    });
    render(data);
  }catch(error){document.getElementById('state').textContent='Terrain unavailable · telemetry still active';}
  finally{sampling=false;}
}
async function update(){try{const response=await fetch('/api/telemetry');const data=await response.json();if(!data.points.length)return;render(data);sampleGround(data);}catch(e){document.getElementById('state').textContent='Telemetry connection lost';}}
update();setInterval(update,500);
</script></body></html>"""


def render_map_page(cesium_token=""):
    """Inject the browser-readable ion token without storing it in source."""
    return MAP_PAGE.replace("__CESIUM_TOKEN__", json.dumps(cesium_token))


def make_handler(tracker, cesium_token=""):
    class Handler(SimpleHTTPRequestHandler):
        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html"):
                body = render_map_page(cesium_token).encode()
                content_type = "text/html; charset=utf-8"
            elif path in ("/api/telemetry", "/api/points"):
                body, content_type = json.dumps(tracker.snapshot()).encode(), "application/json"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):
            pass

    return Handler


def main():
    parser = argparse.ArgumentParser(description="3D GPS rocket tracker")
    parser.add_argument("-p", "--port", help="Serial port (auto-detected when omitted)")
    parser.add_argument("-b", "--baud", type=int, default=115200)
    parser.add_argument("--port-num", type=int, default=8080, help="Web server port")
    parser.add_argument("--kml", help="Save the flown 3D track to KML on exit")
    parser.add_argument("--log-file", default="telemetry-backup.jsonl",
                        help="Append-only telemetry recovery log (default: telemetry-backup.jsonl)")
    parser.add_argument("--demo", action="store_true", help="Run a simulated showcase flight")
    parser.add_argument("--demo-rate", type=float, default=1.0, help="Simulation speed multiplier")
    parser.add_argument("--list-devices", action="store_true", help="List detected serial devices and exit")
    args = parser.parse_args()
    cesium_token = os.environ.get("CESIUM_ION_TOKEN") or load_local_env().get("CESIUM_ION_TOKEN", "")

    devices = discover_devices()
    if args.list_devices:
        if not devices:
            print("No serial devices found")
        for device in devices:
            print(f"{device['port']}\t{device['description']}\t{device['hwid']}")
        return

    try:
        port = None if args.demo else (args.port or choose_device(devices))
    except RuntimeError as exc:
        parser.error(str(exc))
    tracker = GPSTracker(port, args.baud, args.log_file)

    def stop_from_signal(_sig, _frame):
        # Raising here lets serve_forever unwind without its same-thread
        # shutdown deadlock; final cleanup happens in the finally block below.
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, stop_from_signal)
    signal.signal(signal.SIGTERM, stop_from_signal)

    if args.demo:
        if args.demo_rate <= 0:
            parser.error("--demo-rate must be greater than zero")
        print(f"Starting simulated rocket flight at {args.demo_rate:g}x speed")
        tracker.start_simulation(args.demo_rate)
    else:
        tracker.connect()
        tracker.start()

    server = HTTPServer(("0.0.0.0", args.port_num), make_handler(tracker, cesium_token))
    print(f"3D tracker: http://localhost:{args.port_num}")
    if cesium_token:
        print("Cesium World Terrain enabled")
    else:
        print("Terrain disabled: set CESIUM_ION_TOKEN to enable it")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        print("\nShutting down...")
        tracker.disconnect()
        if args.kml:
            tracker.save_kml(args.kml)
        server.server_close()


if __name__ == "__main__":
    main()
