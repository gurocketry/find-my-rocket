# Web Serial PWA

This Vite + React single-page app runs the GPS tracker entirely in the browser. It reads Astra
telemetry over USB, parses and recovers packets, stores the flight log in
IndexedDB, shows the rocket and phone location on the map, predicts the current
trajectory, and remains installable/offline as a PWA.

## Development

```sh
npm install
npm run dev
```

The React UI is split by responsibility: feature views live in `src/views`,
reusable interface pieces in `src/components`, and the telemetry application
state and actions in `src/tracker`. The protocol, transport, storage, and audio
modules remain framework-independent and retain their Node test coverage.

On phones, the tracker has Telemetry (map and recovery compass), Data (live
height and vertical-velocity plots with peak readings and apogee), Device
(faults and mesh status), and full-height Log pages. A status toolbar stays
visible on every page. Desktop shows these panels together in one dashboard.
The receiver connection dialog opens on the first visit and can be reopened
from the toolbar after a disconnect.

Use the HTTPS URL when opening the app from another device. `localhost` is also
treated as secure during desktop development, but an Android phone accessing a
LAN IP requires HTTPS.

## Board connection

The app does not restrict the picker to a specific USB vendor or product ID.
Choose the ground station from the browser's serial-device prompt. This allows
both the Astra firmware identity and boards using the STM32 CDC identity
`0483:5740` to connect without an app update. The default baud is `115200`,
matching the current ground-station firmware.

The connection dialog also offers `9600` for legacy receivers.

After the user enables phone location, each new fix is sent to the connected
ground station as `latitude longitude\n`. If location was enabled before the
board connected, the latest fix is sent immediately after connection.

The current serial format identifies every mesh source and sequence number. Flight
packets look like `[0-42] [flight] state, flags, latitude, longitude, altitude`;
ground station pings look like `[3-7] latitude, longitude, altitude`. The Mesh tab combines
these packet records with the periodic positional `[health]rssi, avg_rssi, snr, ...`
CSV line to show radio, relay, queue,
duplicate, sequence-gap, and per-node delivery information. Other ground stations
appear as orange dots at their latest fix on the map; their movement is not drawn
as a path.

Desktop Chromium uses native Web Serial and shows all serial ports. Chrome on
Android uses WebUSB: the app first shows every non-blocklisted USB device, then
validates that the selected device exposes standard CDC-ACM control (class 2)
and data (class 10) interfaces. This avoids the polyfill's class-only chooser
filter, which can hide some STM32 devices before permission is granted. The
phone still needs USB host/OTG support and an OTG cable.

Close any native serial app before connecting because Android allows only one
application to own the USB interface. Open the installed PWA from Chrome rather
than an embedded browser inside another app.

The first connection must be initiated with the **Connect board** button in the connection dialog so the
browser can show its device permission picker. iOS/Safari and Firefox do not
provide the required USB APIs.

## Offline field use

Install the PWA while a reliable connection is available and wait for the first
page load to complete. Its service worker preloads the full application shell,
including the generated JavaScript, CSS, manifest, and icon. Compass, raw log,
saved records, phone GPS, and board communication then work without internet.

Map tiles are cached only after they have been viewed. Before leaving coverage,
open and pan/zoom around the expected recovery area at the zoom levels you will
need. Unvisited map areas may be blank offline; use the Compass tab when that
happens.
