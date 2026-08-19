import "leaflet/dist/leaflet.css";
import "./styles.css";
import L from "leaflet";
import { FlightTrack, PacketFramer, STAGES, distanceMetres, parsePackets } from "./telemetry.js";
import { SerialConnection, transportSupport } from "./serial.js";
import { exportRecords, loadRecords, storeRecord } from "./storage.js";

const elements = Object.fromEntries([
  "connect", "baud", "locate", "export", "install", "install-banner", "connection-pill",
  "flight-stage", "status-detail", "altitude", "vertical-speed", "range", "signal",
  "satellites", "packet-count", "error-count", "packet-log",
].map((id) => [id, document.getElementById(id)]));

const map = L.map("map", { zoomControl: false, attributionControl: true }).setView([55.8708, -4.2898], 14);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const rocketIcon = L.divIcon({ className: "rocket-marker", html: "<span>▲</span>", iconSize: [34, 34], iconAnchor: [17, 17] });
const userIcon = L.divIcon({ className: "user-marker", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] });
const rocketMarker = L.marker([55.8708, -4.2898], { icon: rocketIcon, zIndexOffset: 1000 }).addTo(map).bindTooltip("ROCKET", { permanent: true, direction: "top", offset: [0, -14] });
const userMarker = L.marker([0, 0], { icon: userIcon, zIndexOffset: 900 });
const accuracyCircle = L.circle([0, 0], { radius: 1, color: "#62f5a5", fillOpacity: 0.12, weight: 1 });
const flownLine = L.polyline([], { color: "#ff5576", weight: 4 }).addTo(map);
const predictionLine = L.polyline([], { color: "#42d9ff", weight: 3, dashArray: "9 10" }).addTo(map);

const track = new FlightTrack();
const framer = new PacketFramer();
let connection = null;
let userPosition = null;
let rejectedCount = 0;
let hasCentered = false;
let deferredInstall = null;

function setConnection(connected, detail) {
  elements["connection-pill"].className = `pill ${connected ? "online" : "offline"}`;
  elements["connection-pill"].innerHTML = `<span></span>${connected ? detail : "OFFLINE"}`;
  elements.connect.textContent = connected ? "DISCONNECT" : "CONNECT BOARD";
  elements["status-detail"].textContent = connected ? `Receiving Astra telemetry via ${detail}.` : detail;
}

function addLog(message, type = "ok") {
  const item = document.createElement("li");
  item.className = type;
  item.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  elements["packet-log"].prepend(item);
  while (elements["packet-log"].children.length > 30) elements["packet-log"].lastElementChild.remove();
}

async function reject(raw, reason = "Malformed packet") {
  if (!raw.trim()) return;
  rejectedCount += 1;
  elements["error-count"].textContent = `${rejectedCount} rejected`;
  addLog(`${reason}: ${raw.slice(0, 100)}`, "error");
  await storeRecord({ record: "rejected", reason, raw: raw.slice(0, 2048) }).catch(() => {});
}

function render(point) {
  const points = track.points.map((row) => [row.lat, row.lon]);
  flownLine.setLatLngs(points);
  predictionLine.setLatLngs(track.prediction().map((row) => [row.lat, row.lon]));
  rocketMarker.setLatLng([point.lat, point.lon]);
  elements.altitude.textContent = point.alt.toFixed(1);
  elements["vertical-speed"].textContent = track.velocity.vertical.toFixed(1);
  elements.signal.textContent = point.rssi;
  elements.satellites.textContent = point.sats;
  elements["packet-count"].textContent = track.points.length;
  elements["flight-stage"].textContent = STAGES.get(point.stage) || "UNKNOWN";
  elements["flight-stage"].className = `stage stage-${point.stage}`;
  elements.range.textContent = userPosition ? (distanceMetres(userPosition, point) / 1000).toFixed(2) : "—";
  elements.export.disabled = false;
  if (!hasCentered) {
    map.setView([point.lat, point.lon], 16);
    hasCentered = true;
  }
}

async function accept(packet) {
  const point = track.add(packet);
  render(point);
  addLog(`${STAGES.get(point.stage)} · ${point.lat.toFixed(6)}, ${point.lon.toFixed(6)} · ${point.alt.toFixed(1)} m`);
  await storeRecord({ record: "telemetry", transport: connection?.mode, point }).catch((error) => {
    elements["status-detail"].textContent = `Telemetry active; local log failed: ${error.message}`;
  });
}

async function processText(text) {
  const framed = framer.push(text);
  for (const overflow of framed.rejected) await reject(overflow, "Receive buffer resynchronised");
  for (const line of framed.lines) {
    const parsed = parsePackets(line);
    for (const raw of parsed.rejected) await reject(raw);
    for (const packet of parsed.packets) await accept(packet);
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
      reject(String(event.detail), "Serial read recovered");
      elements["status-detail"].textContent = "Serial packet error recovered; listening for the next packet.";
    });
    connection.addEventListener("status", (event) => {
      if (!event.detail.connected) setConnection(false, "USB connection lost. Reconnect the board to continue.");
    });
    await connection.connect();
    elements.baud.disabled = true;
    setConnection(true, connection.mode.toUpperCase());
  } catch (error) {
    if (error.name !== "NotFoundError") addLog(`Connection failed: ${error.message}`, "error");
    setConnection(false, error.name === "NotFoundError" ? "No board selected." : `Connection failed: ${error.message}`);
  }
});

elements.locate.addEventListener("click", () => {
  if (!navigator.geolocation) {
    elements["status-detail"].textContent = "Location is not available in this browser.";
    return;
  }
  navigator.geolocation.watchPosition((position) => {
    userPosition = { lat: position.coords.latitude, lon: position.coords.longitude };
    userMarker.setLatLng(userPosition).addTo(map);
    accuracyCircle.setLatLng(userPosition).setRadius(position.coords.accuracy).addTo(map);
    elements.locate.textContent = `GPS ±${Math.round(position.coords.accuracy)} m`;
    if (track.points.length) render(track.points.at(-1));
  }, (error) => {
    elements["status-detail"].textContent = `Device location unavailable: ${error.message}`;
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
});

elements.export.addEventListener("click", () => exportRecords());

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
  elements.export.disabled = records.length === 0;
  if (records.length) elements["status-detail"].textContent += ` ${records.length} saved records available.`;
}).catch(() => {});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
