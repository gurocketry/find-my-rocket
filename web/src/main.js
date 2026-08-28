import "leaflet/dist/leaflet.css";
import "./styles.css";
import L from "leaflet";
import {
  FlightTrack, MeshNetwork, PacketFramer, STAGES, bearingDegrees, distanceMetres,
  parseHealthLine, parsePackets,
} from "./telemetry.js";
import { SerialConnection, transportSupport } from "./serial.js";
import { clearRecords, exportRawLog, loadRecords, storeRecord } from "./storage.js";

const elements = Object.fromEntries([
  "connect", "baud", "locate", "install", "install-banner", "connection-pill",
  "last-packet-time",
  "flight-stage", "status-detail", "altitude", "vertical-speed", "range", "signal",
  "satellites", "packet-count", "error-count", "raw-count", "raw-log", "save-log", "clear-log",
  "compass-locate", "enable-compass", "compass-status", "compass-arrow", "compass-distance",
  "compass-bearing", "compass-heading", "compass-fix",
  "mesh-state", "mesh-node-count", "mesh-rx", "mesh-accepted", "mesh-duplicates",
  "mesh-rssi", "mesh-snr", "mesh-relayed", "mesh-queue", "mesh-nodes-body",
].map((id) => [id, document.getElementById(id)]));

const map = L.map("map", { zoomControl: false, attributionControl: true }).setView([55.8708, -4.2898], 14);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const rocketIcon = L.divIcon({ className: "rocket-marker", html: "<span>▲</span>", iconSize: [34, 34], iconAnchor: [17, 17] });
const userIcon = L.divIcon({ className: "user-marker", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] });
const groundStationIcon = L.divIcon({ className: "ground-station-marker", html: "<span></span>", iconSize: [26, 26], iconAnchor: [13, 13] });
const rocketMarker = L.marker([55.8708, -4.2898], { icon: rocketIcon, zIndexOffset: 1000 }).addTo(map).bindTooltip("ROCKET", { permanent: true, direction: "top", offset: [0, -14] });
const userMarker = L.marker([0, 0], { icon: userIcon, zIndexOffset: 900 });
const accuracyCircle = L.circle([0, 0], { radius: 1, color: "#62f5a5", fillOpacity: 0.12, weight: 1 });
const flownLine = L.polyline([], { color: "#ff5576", weight: 4 }).addTo(map);
const predictionLine = L.polyline([], { color: "#42d9ff", weight: 3, dashArray: "9 10" }).addTo(map);
const groundStationMarkers = new Map();

let track = new FlightTrack();
let mesh = new MeshNetwork();
let framer = new PacketFramer();
const rawLines = [];
let rawStoreQueue = Promise.resolve();
let connection = null;
let userPosition = null;
let userAccuracy = null;
let phoneHeading = null;
let locationWatchId = null;
let orientationListening = false;
let rejectedCount = 0;
let hasCentered = false;
let deferredInstall = null;
let trackedFlightNode = null;

function setConnection(connected, detail) {
  elements["connection-pill"].className = `pill ${connected ? "online" : "offline"}`;
  elements["connection-pill"].innerHTML = `<span></span>${connected ? detail : "OFFLINE"}`;
  elements.connect.textContent = connected ? "DISCONNECT" : "CONNECT BOARD";
  elements["status-detail"].textContent = connected ? `Receiving Astra telemetry via ${detail}.` : detail;
}

function setLastPacket(receivedAt) {
  const date = new Date(receivedAt);
  if (Number.isNaN(date.getTime())) return;
  elements["last-packet-time"].dateTime = date.toISOString();
  elements["last-packet-time"].textContent = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  elements["last-packet-time"].title = date.toLocaleString();
}

function appendRawLine(raw, { persist = true } = {}) {
  if (!raw.trim()) return;
  rawLines.push(raw);
  if (rawLines.length > 5000) rawLines.shift();
  elements["raw-log"].textContent = rawLines.join("\n");
  elements["raw-log"].scrollTop = elements["raw-log"].scrollHeight;
  elements["raw-count"].textContent = `${rawLines.length} ${rawLines.length === 1 ? "line" : "lines"}`;
  elements["save-log"].disabled = false;
  elements["clear-log"].disabled = false;
  if (persist) {
    rawStoreQueue = rawStoreQueue
      .then(() => storeRecord({ record: "raw", transport: connection?.mode || null, raw }))
      .catch(() => {});
  }
}

async function reject(raw, reason = "Malformed packet") {
  if (!raw.trim()) return;
  rejectedCount += 1;
  elements["error-count"].textContent = `${rejectedCount} rejected`;
  await storeRecord({ record: "rejected", reason, raw: raw.slice(0, 2048) }).catch(() => {});
}

function cardinal(degrees) {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(degrees / 45) % 8];
}

function renderCompass() {
  const rocket = track.points.at(-1);
  elements["compass-fix"].textContent = rocket ? `${rocket.lat.toFixed(5)}, ${rocket.lon.toFixed(5)}` : "—";
  elements["compass-heading"].textContent = phoneHeading === null ? "—" : `${Math.round(phoneHeading)}° ${cardinal(phoneHeading)}`;

  if (!rocket) {
    elements["compass-status"].textContent = "Waiting for the first valid rocket GPS packet.";
    elements["compass-arrow"].classList.remove("ready");
    return;
  }
  if (!userPosition) {
    elements["compass-status"].textContent = "Enable your location to calculate the route to the rocket.";
    elements["compass-arrow"].classList.remove("ready");
    return;
  }

  const distance = distanceMetres(userPosition, rocket);
  const bearing = bearingDegrees(userPosition, rocket);
  elements["compass-distance"].textContent = distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(2)} km`;
  elements["compass-bearing"].textContent = `${Math.round(bearing)}° ${cardinal(bearing)}`;
  if (phoneHeading === null) {
    elements["compass-status"].textContent = "Target found. Enable the compass to make the arrow follow your phone.";
    elements["compass-arrow"].style.transform = `rotate(${bearing}deg)`;
    elements["compass-arrow"].classList.remove("ready");
    return;
  }

  const relativeBearing = (bearing - phoneHeading + 360) % 360;
  elements["compass-arrow"].style.transform = `rotate(${relativeBearing}deg)`;
  elements["compass-arrow"].classList.add("ready");
  elements["compass-status"].textContent = `Follow the arrow · phone GPS ±${Math.round(userAccuracy || 0)} m`;
}

function render(point) {
  const points = track.points.map((row) => [row.lat, row.lon]);
  flownLine.setLatLngs(points);
  predictionLine.setLatLngs(track.prediction().map((row) => [row.lat, row.lon]));
  rocketMarker.setLatLng([point.lat, point.lon]).addTo(map);
  elements.altitude.textContent = point.alt.toFixed(1);
  elements["vertical-speed"].textContent = track.velocity.vertical.toFixed(1);
  elements.signal.textContent = point.rssi ?? mesh.health?.rssi ?? "—";
  elements.satellites.textContent = point.sats ?? "—";
  elements["packet-count"].textContent = track.points.length;
  elements["flight-stage"].textContent = STAGES.get(point.stage) || "UNKNOWN";
  elements["flight-stage"].className = `stage stage-${point.stage}`;
  elements.range.textContent = userPosition ? (distanceMetres(userPosition, point) / 1000).toFixed(2) : "—";
  renderCompass();
  if (!hasCentered) {
    map.setView([point.lat, point.lon], 16);
    hasCentered = true;
  }
}

function updateGroundStationMarker(packet) {
  if (packet.lat === 0 && packet.lon === 0) return;
  let marker = groundStationMarkers.get(packet.sender);
  if (!marker) {
    marker = L.marker([packet.lat, packet.lon], { icon: groundStationIcon, zIndexOffset: 800 })
      .addTo(map)
      .bindTooltip(`GROUND ${packet.sender}`, { permanent: true, direction: "top", offset: [0, -12] });
    groundStationMarkers.set(packet.sender, marker);
  } else {
    marker.setLatLng([packet.lat, packet.lon]);
  }
}

function healthValue(key, fallback = "—") {
  return mesh.health?.[key] ?? fallback;
}

function renderMesh() {
  const nodes = mesh.snapshot();
  elements["mesh-node-count"].textContent = nodes.length;
  elements["mesh-rx"].textContent = healthValue("rx", nodes.reduce((sum, node) => sum + node.packets, 0));
  elements["mesh-accepted"].textContent = healthValue("accepted");
  elements["mesh-duplicates"].textContent = healthValue("duplicates", nodes.reduce((sum, node) => sum + node.duplicates, 0));
  elements["mesh-rssi"].textContent = healthValue("avg_rssi");
  elements["mesh-snr"].textContent = healthValue("avg_snr");
  elements["mesh-relayed"].textContent = healthValue("relayed");
  elements["mesh-queue"].textContent = `${healthValue("queue")} / ${healthValue("queue_drops")}`;
  const state = healthValue("mesh", nodes.length ? "active" : "never");
  elements["mesh-state"].textContent = String(state).toUpperCase();
  elements["mesh-state"].className = `mesh-state mesh-${state}`;

  const rows = nodes.map((node) => {
    const row = document.createElement("tr");
    const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(node.lastSeen).getTime()) / 1000));
    const cells = [
      node.id,
      node.kind === "ground" ? "GROUND" : "FLIGHT",
      node.packets,
      node.uniquePackets,
      node.duplicates,
      node.missedPackets,
      node.lastSequence,
      `${ageSeconds}s`,
    ];
    for (const value of cells) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  });
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.textContent = "Waiting for mesh packets…";
    row.append(cell);
    rows.push(row);
  }
  elements["mesh-nodes-body"].replaceChildren(...rows);
}

function resetTelemetryState() {
  track = new FlightTrack();
  mesh = new MeshNetwork();
  framer = new PacketFramer();
  rawLines.length = 0;
  rejectedCount = 0;
  trackedFlightNode = null;
  hasCentered = false;

  flownLine.setLatLngs([]);
  predictionLine.setLatLngs([]);
  rocketMarker.remove();
  groundStationMarkers.forEach((marker) => marker.remove());
  groundStationMarkers.clear();

  elements["raw-log"].textContent = "Waiting for serial data…";
  elements["raw-count"].textContent = "0 lines";
  elements["error-count"].textContent = "0 rejected";
  elements["save-log"].disabled = true;
  elements["clear-log"].disabled = true;
  elements["last-packet-time"].removeAttribute("datetime");
  elements["last-packet-time"].removeAttribute("title");
  elements["last-packet-time"].textContent = "—";
  elements.altitude.textContent = "—";
  elements["vertical-speed"].textContent = "—";
  elements.range.textContent = "—";
  elements.signal.textContent = "—";
  elements.satellites.textContent = "—";
  elements["packet-count"].textContent = "0";
  elements["flight-stage"].textContent = "WAITING FOR TELEMETRY";
  elements["flight-stage"].className = "stage";
  elements["compass-distance"].textContent = "—";
  elements["compass-bearing"].textContent = "—";
  renderCompass();
  renderMesh();
}

async function accept(packet) {
  const receivedAt = new Date();
  const observation = mesh.observe(packet, receivedAt);
  setLastPacket(receivedAt);
  renderMesh();

  if (packet.kind === "ground") {
    updateGroundStationMarker(packet);
    await storeRecord({ record: "mesh", transport: connection?.mode, receivedAt: receivedAt.toISOString(), packet }).catch(() => {});
    return;
  }
  if (observation?.duplicate) {
    await storeRecord({ record: "mesh", transport: connection?.mode, receivedAt: receivedAt.toISOString(), packet }).catch(() => {});
    return;
  }
  if (packet.sender !== null && trackedFlightNode !== null && packet.sender !== trackedFlightNode) {
    await storeRecord({ record: "mesh", transport: connection?.mode, receivedAt: receivedAt.toISOString(), packet }).catch(() => {});
    return;
  }
  if (packet.sender !== null && trackedFlightNode === null) trackedFlightNode = packet.sender;
  const point = track.add(packet, receivedAt);
  render(point);
  await storeRecord({ record: "telemetry", transport: connection?.mode, point }).catch((error) => {
    elements["status-detail"].textContent = `Telemetry active; local log failed: ${error.message}`;
  });
}

async function processText(text) {
  const framed = framer.push(text);
  for (const overflow of framed.rejected) {
    appendRawLine(overflow);
    await reject(overflow, "Receive buffer resynchronised");
  }
  for (const line of framed.lines) {
    appendRawLine(line);
    const health = parseHealthLine(line);
    if (health) {
      mesh.updateHealth(health);
      renderMesh();
      continue;
    }
    const parsed = parsePackets(line);
    for (const raw of parsed.rejected) await reject(raw);
    for (const packet of parsed.packets) await accept(packet);
  }
}

function startLocationWatch() {
  if (!navigator.geolocation) {
    elements["status-detail"].textContent = "Location is not available in this browser.";
    elements["compass-status"].textContent = "Location is not available in this browser.";
    return;
  }
  if (locationWatchId !== null) return;
  elements.locate.textContent = "LOCATING…";
  elements["compass-locate"].textContent = "LOCATING…";
  locationWatchId = navigator.geolocation.watchPosition((position) => {
    userPosition = { lat: position.coords.latitude, lon: position.coords.longitude };
    userAccuracy = position.coords.accuracy;
    userMarker.setLatLng(userPosition).addTo(map);
    accuracyCircle.setLatLng(userPosition).setRadius(userAccuracy).addTo(map);
    elements.locate.textContent = `GPS ±${Math.round(userAccuracy)} m`;
    elements["compass-locate"].textContent = `GPS ±${Math.round(userAccuracy)} m`;
    if (track.points.length) render(track.points.at(-1));
    else renderCompass();
  }, (error) => {
    locationWatchId = null;
    elements["status-detail"].textContent = `Device location unavailable: ${error.message}`;
    elements["compass-status"].textContent = `Device location unavailable: ${error.message}`;
    elements.locate.textContent = "MY LOCATION";
    elements["compass-locate"].textContent = "USE MY LOCATION";
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
}

function orientationChanged(event) {
  const heading = Number.isFinite(event.webkitCompassHeading)
    ? event.webkitCompassHeading
    : Number.isFinite(event.alpha) ? (360 - event.alpha + 360) % 360 : null;
  if (heading === null) return;
  phoneHeading = heading;
  renderCompass();
}

async function enableCompass() {
  try {
    if (typeof DeviceOrientationEvent === "undefined") throw new Error("This device does not expose a compass.");
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") throw new Error("Compass permission was not granted.");
    }
    if (!orientationListening) {
      window.addEventListener("deviceorientationabsolute", orientationChanged, true);
      window.addEventListener("deviceorientation", orientationChanged, true);
      orientationListening = true;
    }
    elements["enable-compass"].textContent = "COMPASS ON";
    elements["compass-status"].textContent = "Move the phone in a figure eight if the heading seems inaccurate.";
  } catch (error) {
    elements["compass-status"].textContent = error.message;
  }
}

elements.connect.addEventListener("click", async () => {
  if (connection?.reading) {
    await connection.disconnect();
    elements.baud.disabled = false;
    setConnection(false, "Board disconnected. Telemetry remains saved on this device.");
    return;
  }
  try {
    connection = new SerialConnection(Number(elements.baud.value));
    connection.addEventListener("data", (event) => processText(event.detail));
    connection.addEventListener("recoverable-error", (event) => {
      const message = String(event.detail);
      reject(message, "Serial read recovered");
      elements["status-detail"].textContent = "Serial packet error recovered; listening for the next packet.";
    });
    connection.addEventListener("status", (event) => {
      if (!event.detail.connected) setConnection(false, "USB connection lost. Reconnect the board to continue.");
    });
    await connection.connect();
    elements.baud.disabled = true;
    setConnection(true, connection.mode.toUpperCase());
  } catch (error) {
    setConnection(false, error.name === "NotFoundError" ? "No board selected." : `Connection failed: ${error.message}`);
  }
});

elements.locate.addEventListener("click", startLocationWatch);
elements["compass-locate"].addEventListener("click", startLocationWatch);
elements["enable-compass"].addEventListener("click", enableCompass);
elements["save-log"].addEventListener("click", async () => {
  await rawStoreQueue;
  await exportRawLog();
});
elements["clear-log"].addEventListener("click", async () => {
  if (!window.confirm("Clear all saved and current telemetry from every page? This cannot be undone.")) return;
  elements["clear-log"].disabled = true;
  await rawStoreQueue;
  try {
    await clearRecords();
    resetTelemetryState();
    elements["status-detail"].textContent = connection?.reading
      ? "Telemetry cleared. Still connected and waiting for the next packet."
      : "Telemetry cleared. Connect the Astra ground station to start a new log.";
  } catch (error) {
    elements["clear-log"].disabled = false;
    elements["status-detail"].textContent = `Could not clear saved telemetry: ${error.message}`;
  }
});

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab-view").forEach((view) => {
    const active = view.id === tab.dataset.view;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  document.querySelectorAll(".tab").forEach((button) => {
    const active = button === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  if (tab.dataset.view === "map-view") requestAnimationFrame(() => map.invalidateSize());
}));

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event;
  elements["install-banner"].hidden = false;
});
elements.install.addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  elements["install-banner"].hidden = true;
});

const support = transportSupport();
if (!window.isSecureContext) {
  elements.connect.disabled = true;
  setConnection(false, "HTTPS is required for USB and GPS access.");
} else if (!support.available) {
  elements.connect.disabled = true;
  setConnection(false, "Use Chrome or Edge. Android uses the WebUSB fallback.");
} else {
  setConnection(false, `${support.mode} ready. Tap Connect Board.`);
}

loadRecords().then((records) => {
  const savedRaw = records.filter((record) => record.record === "raw");
  savedRaw.slice(-5000).forEach((record) => appendRawLine(record.raw, { persist: false }));
  rejectedCount = records.filter((record) => record.record === "rejected").length;
  elements["error-count"].textContent = `${rejectedCount} rejected`;
  const latestTelemetry = records.filter((record) => record.record === "telemetry").at(-1);
  if (latestTelemetry?.point?.receivedAt) setLastPacket(latestTelemetry.point.receivedAt);
  if (records.length) {
    elements["clear-log"].disabled = false;
    elements["status-detail"].textContent += ` ${records.length} saved records available.`;
  }
}).catch(() => {});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");

renderMesh();
setInterval(renderMesh, 1000);
