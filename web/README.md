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

The Astra STM32 ground station is filtered by its firmware USB IDs:

- vendor: `0x1EAF`
- product: `0x0003`
- default baud: `9600` (matching Astra's current ground-station reader)

The connection panel also offers `115200` for receivers using the GPS tracker's
newer high-speed configuration.

Desktop Chromium uses native Web Serial. Chrome on Android automatically uses
the WebUSB-backed Serial API polyfill, so the phone needs USB host/OTG support
and an OTG cable. The board must expose an accessible USB CDC-ACM interface.

The first connection must be initiated with the **Connect board** button so the
browser can show its device permission picker. iOS/Safari and Firefox do not
provide the required USB APIs.
