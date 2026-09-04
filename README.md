# GUR Rocket Tracker PWA

The browser-based Progressive Web App is the tracker. It connects directly to
an Astra ground station over USB, parses telemetry locally, stores the flight
log in IndexedDB, and provides map, compass, mesh, fault, and raw-log views.

## Development

```sh
cd web
npm install
npm run dev
```

Use HTTPS when opening the app from another device. `localhost` is treated as a
secure context during desktop development. USB, location, and orientation
features require browser permission.

Run the checks and production build with:

```sh
npm test
npm run build
```

## GitHub Pages

Every push to `main`, `master`, or `web-serial-pwa` builds and deploys `web/` to
GitHub Pages through [`.github/workflows/pages.yml`](.github/workflows/pages.yml).
The Vite build uses relative asset paths, so it works at both a custom domain
and a repository URL such as `https://username.github.io/repository/`.

In the repository settings, set Pages → Build and deployment → Source to
**GitHub Actions**. Open the deployed page in Chrome or Edge for USB support;
iOS Safari and Firefox do not provide the required USB APIs.

## Offline field use

Install the PWA while online and wait for the first page load to finish. The
service worker caches the app shell and visited map tiles. Compass, raw logs,
saved records, phone GPS, and board communication continue to work offline.
Unvisited map areas may be blank without a connection, so use Compass when
needed.

## Board connection

Open SETUP and choose the ground station from the browser’s serial-device
prompt. The default baud is `115200`; `9600` remains available for legacy
receivers. The app supports native Web Serial on desktop Chromium and the
WebUSB fallback on Chrome for Android.

After location access is enabled, each new phone fix is sent to the connected
ground station as `latitude longitude\n`. If location was enabled before the
board connected, the latest fix is sent immediately after connection.
