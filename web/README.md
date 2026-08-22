# Web Serial PWA

This version runs the GPS tracker entirely in the browser. It reads Astra
telemetry over USB, parses and recovers packets, stores the flight log in
IndexedDB, shows the rocket and phone location on the map, predicts the current
trajectory, exports JSONL, and remains installable/offline as a PWA.

## Development

```sh
npm install
npm run dev
```

Use the HTTPS URL when opening the app from another device. `localhost` is also
treated as secure during desktop development, but an Android phone accessing a
LAN IP requires HTTPS.

## Board connection

The app does not restrict the picker to a specific USB vendor or product ID.
Choose the ground station from the browser's serial-device prompt. This allows
both the Astra firmware identity and boards using the STM32 CDC identity
`0483:5740` to connect without an app update. The default baud is `9600`,
matching Astra's current ground-station reader.

The connection panel also offers `115200` for receivers using the GPS tracker's
newer high-speed configuration.

Desktop Chromium uses native Web Serial and shows all serial ports. Chrome on
Android automatically uses the WebUSB-backed Serial API polyfill, so its picker
shows USB CDC devices; the phone needs USB host/OTG support and an OTG cable.
The board must expose an accessible USB CDC-ACM interface.

The first connection must be initiated with the **Connect board** button so the
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
