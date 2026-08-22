# 3D GPS Rocket Tracker

The tracker discovers a connected serial receiver, reads GPS telemetry, detects launch, and displays the flown path and a live ballistic projection on a Cesium 3D globe.

## Showcase without hardware

```sh
python3 gps_tracker.py --demo
```

Open <http://localhost:8080>. The demo waits on the pad, launches, flies a complete simulated trajectory, and leaves the completed flight on screen. Use `--demo-rate 5` to run it five times faster.

On phones, tablets, and computers with location hardware, the map requests the
browser's location and shows the ground station as a green `YOU` marker with an
accuracy circle and live distance to the rocket. Browser geolocation requires
permission and a secure context (HTTPS, or `localhost` during development).

For streamed 3D terrain, paste your token into the already-created `.env` file and run normally:

```sh
# edit .env and paste the token after CESIUM_ION_TOKEN=
python3 gps_tracker.py --demo
```

With terrain enabled, the viewer calibrates the terrain height to the pre-launch GPS fix, displays approximate height above ground level, and clips the prediction where it meets the sampled landscape. If terrain cannot load, telemetry continues with the smooth-globe fallback.

Run its automated checks with:

```sh
python3 -m unittest -v
```

## Plot a recorded log

Generate a high-resolution telemetry summary from the Astra flight-board log:

```sh
nix develop
python3 plot_log.py
```

The graph is saved as `log_plot.png`. Pass another Astra log as the first argument,
choose a destination with `--output`, or add `--show` for an interactive window:

```sh
python3 plot_log.py astra_real_log.csv --output flight.png --show
```

The plot uses Astra's onboard microsecond timestamps, flight states, Kalman
altitude and velocity, barometric altitude, valid GPS altitude fixes, and
accelerometer magnitude. Velocity and acceleration have separate panels.
Sparse update rows and corrupt sentinel values are filtered automatically.
The environmental timestamps are also interpolated against the onboard Kalman
altitude to produce a gas-resistance and methane-versus-altitude comparison.
Each chart is additionally exported as a separate 16:9 PNG in
`log_plot_pages/`, ready to place directly into presentation slides. Choose a
different destination with `--pages-dir`.

If `status.csv` or `solara.csv` is present, its environmental readings are
included automatically. The environmental log is aligned so its first reading
coincides with the first GPS descent sample; this matches boards that begin
logging at descent. Choose a file explicitly with `--environment readings.csv`.

## Track a receiver

```sh
python3 gps_tracker.py
```

One connected serial device is selected automatically. If several devices are connected, the tracker asks which one to use. For unattended operation, select it explicitly:

```sh
python3 gps_tracker.py --port /dev/cu.usbmodemYOUR_DEVICE --baud 115200
```

Use `--list-devices` to inspect discovery and `--kml flight.kml` to save the flown 3D path on exit.

Every accepted telemetry fix is also appended immediately to `telemetry-backup.jsonl` and flushed to disk, so a process or browser failure does not erase the raw flight history. Change the destination with `--log-file /path/to/backup.jsonl`; logging is enabled by default.

Malformed input is written to the same recovery journal as a `rejected` record.
The serial reader accepts CR/LF variants, bounds its receive buffer, reconnects
with a clean input buffer, and scans for Astra packet boundaries, allowing the
next intact packet to be recovered even when a delimiter or packet is lost.

## Flight model

Launch is declared after at least four fixes, 15 m of altitude gain, and at least 5 m/s vertical speed. The cyan dashed line is a continuously updated ballistic estimate derived from recent GPS velocity and standard gravity. It is a visualization aid, not a range-safety or flight-control system; wind, drag, thrust, and terrain are not modeled.

The 3D globe loads Cesium, Cesium World Terrain, and OpenStreetMap tiles from the internet. Their automatically generated on-screen credits remain visible to satisfy attribution requirements. Telemetry stays on the local machine. For anything beyond local development, create a dedicated Cesium token with only `assets:read`, restrict it to the World Terrain asset and your app URL, and monitor its usage in the ion dashboard.

## Web Serial PWA

The `web-serial-pwa` branch contains an installable mobile ground station under
`web/`. It connects directly to the Astra board from a supported browser and has
three separate field views:

- **Map** shows the live flight path, prediction, telemetry, and phone position.
- **Compass** points from the phone's current GPS fix toward the latest rocket fix
  without depending on map tiles. Tap both permission buttons, then hold the phone
  flat; recalibrate with a figure-eight motion if the heading drifts.
- **Log** shows the exact scrollable serial text, including malformed input and
  recovery messages, and saves the complete device-local raw history as a `.txt`
  file.

Run the web app locally with `cd web && npm install && npm run dev`. USB, location,
and orientation access require browser permission and a secure context (HTTPS or
localhost). Previously loaded app assets and map tiles remain available offline;
the compass and serial log do not require map connectivity.
