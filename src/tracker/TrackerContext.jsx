import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AudioCues, enteredLanded } from "../audio.js";
import { SerialConnection, formatLocation, transportSupport } from "../serial.js";
import { clearRecords, exportRawLog, loadRecords, storeRecord } from "../storage.js";
import { FlightTrack, MeshNetwork, PacketFramer, decodeFaults, parseHealthLine, parsePackets } from "../telemetry.js";

const TrackerContext = createContext(null);
const initialStatus = { connected: false, detail: "Preparing tracker…", mode: null };

export function TrackerProvider({ children }) {
  const engine = useRef({ track: new FlightTrack(), mesh: new MeshNetwork(), framer: new PacketFramer(), trackedNode: null });
  const connection = useRef(null);
  const audio = useRef(new AudioCues());
  const locationWatch = useRef(null);
  const userLocationRef = useRef(null);
  const storeQueue = useRef(Promise.resolve());
  const [status, setStatus] = useState(initialStatus);
  const [point, setPoint] = useState(null);
  const [trackPoints, setTrackPoints] = useState([]);
  const [prediction, setPrediction] = useState([]);
  const [groundStations, setGroundStations] = useState([]);
  const [mesh, setMesh] = useState({ nodes: [], health: null });
  const [rawLines, setRawLines] = useState([]);
  const [rejectedCount, setRejectedCount] = useState(0);
  const [lastPacketAt, setLastPacketAt] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [heading, setHeading] = useState(null);
  const [baudRate, setBaudRate] = useState(115200);
  const [locating, setLocating] = useState(false);
  const [compassEnabled, setCompassEnabled] = useState(false);
  const [transportAvailable, setTransportAvailable] = useState(true);

  const shareLocation = useCallback((location = userLocationRef.current) => {
    if (!location || !connection.current?.reading) return;
    connection.current.write(formatLocation(location.lat, location.lon)).catch((error) => {
      setStatus((current) => ({ ...current, detail: `Location available, but serial sharing failed: ${error.message}` }));
    });
  }, []);

  const appendRaw = useCallback((raw, persist = true) => {
    if (!raw.trim()) return;
    setRawLines((lines) => [...lines, raw].slice(-5000));
    if (persist) storeQueue.current = storeQueue.current
      .then(() => storeRecord({ record: "raw", transport: connection.current?.mode || null, raw }))
      .catch(() => {});
  }, []);

  const reject = useCallback(async (raw, reason = "Malformed packet") => {
    if (!raw.trim()) return;
    setRejectedCount((count) => count + 1);
    await storeRecord({ record: "rejected", reason, raw: raw.slice(0, 2048) }).catch(() => {});
  }, []);

  const refreshMesh = useCallback(() => {
    setMesh({ nodes: engine.current.mesh.snapshot(), health: engine.current.mesh.health });
  }, []);

  const accept = useCallback(async (packet) => {
    const receivedAt = new Date();
    audio.current.meow();
    const observation = engine.current.mesh.observe(packet, receivedAt);
    setLastPacketAt(receivedAt.toISOString());
    refreshMesh();
    if (packet.kind === "ground") {
      if (packet.lat !== 0 || packet.lon !== 0) setGroundStations((stations) => [
        ...stations.filter((station) => station.sender !== packet.sender), packet,
      ]);
      await storeRecord({ record: "mesh", transport: connection.current?.mode, receivedAt: receivedAt.toISOString(), packet }).catch(() => {});
      return;
    }
    if (observation?.duplicate || (packet.sender !== null && engine.current.trackedNode !== null && packet.sender !== engine.current.trackedNode)) {
      await storeRecord({ record: "mesh", transport: connection.current?.mode, receivedAt: receivedAt.toISOString(), packet }).catch(() => {});
      return;
    }
    if (packet.sender !== null && engine.current.trackedNode === null) engine.current.trackedNode = packet.sender;
    const previousStage = engine.current.track.points.at(-1)?.stage;
    const nextPoint = engine.current.track.add(packet, receivedAt);
    if (enteredLanded(previousStage, nextPoint.stage)) audio.current.boing();
    setPoint(nextPoint);
    setTrackPoints([...engine.current.track.points]);
    setPrediction(engine.current.track.prediction());
    await storeRecord({ record: "telemetry", transport: connection.current?.mode, point: nextPoint }).catch((error) => {
      setStatus((current) => ({ ...current, detail: `Telemetry active; local log failed: ${error.message}` }));
    });
  }, [refreshMesh]);

  const processText = useCallback(async (text) => {
    const framed = engine.current.framer.push(text);
    for (const overflow of framed.rejected) { appendRaw(overflow); await reject(overflow, "Receive buffer resynchronised"); }
    for (const line of framed.lines) {
      appendRaw(line);
      const health = parseHealthLine(line);
      if (health) { engine.current.mesh.updateHealth(health); refreshMesh(); continue; }
      const parsed = parsePackets(line);
      for (const raw of parsed.rejected) await reject(raw);
      for (const packet of parsed.packets) await accept(packet);
    }
  }, [accept, appendRaw, refreshMesh, reject]);

  const toggleConnection = useCallback(async () => {
    if (connection.current?.reading) {
      await connection.current.disconnect();
      setStatus({ connected: false, mode: null, detail: "Board disconnected. Telemetry remains saved on this device." });
      return;
    }
    try {
      await audio.current.enable();
      const next = new SerialConnection(baudRate);
      connection.current = next;
      next.addEventListener("data", (event) => processText(event.detail));
      next.addEventListener("recoverable-error", (event) => {
        reject(String(event.detail), "Serial read recovered");
        setStatus((current) => ({ ...current, detail: "Serial packet error recovered; listening for the next packet." }));
      });
      next.addEventListener("status", (event) => {
        if (!event.detail.connected) setStatus({ connected: false, mode: null, detail: "USB connection lost. Reconnect the board to continue." });
      });
      await next.connect();
      setStatus({ connected: true, mode: next.mode, detail: `Receiving Astra telemetry via ${next.mode}.` });
      shareLocation();
    } catch (error) {
      setStatus({ connected: false, mode: null, detail: error.name === "NotFoundError" ? "No board selected." : `Connection failed: ${error.message}` });
    }
  }, [baudRate, processText, reject, shareLocation]);

  const useDeviceLocation = useCallback(() => {
    if (!navigator.geolocation) { setStatus((current) => ({ ...current, detail: "Location is not available in this browser. Enter coordinates manually." })); return; }
    if (locationWatch.current !== null) return;
    setLocating(true);
    locationWatch.current = navigator.geolocation.watchPosition((position) => {
      const location = { lat: position.coords.latitude, lon: position.coords.longitude, accuracy: position.coords.accuracy, source: "gps" };
      userLocationRef.current = location; setUserLocation(location); setLocating(false); shareLocation(location);
    }, (error) => {
      locationWatch.current = null; setLocating(false);
      setStatus((current) => ({ ...current, detail: `Device location unavailable: ${error.message}. Enter coordinates manually.` }));
    }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
  }, [shareLocation]);

  const useManualLocation = useCallback((lat, lon) => {
    formatLocation(lat, lon);
    if (locationWatch.current !== null) navigator.geolocation?.clearWatch(locationWatch.current);
    locationWatch.current = null;
    const location = { lat, lon, accuracy: null, source: "manual" };
    userLocationRef.current = location; setUserLocation(location); setLocating(false); shareLocation(location);
    setStatus((current) => ({ ...current, detail: "Using manual coordinates; sharing them with the board every 10 seconds." }));
  }, [shareLocation]);

  const enableCompass = useCallback(async () => {
    try {
      if (typeof DeviceOrientationEvent === "undefined") throw new Error("This device does not expose a compass.");
      if (typeof DeviceOrientationEvent.requestPermission === "function" && await DeviceOrientationEvent.requestPermission() !== "granted") throw new Error("Compass permission was not granted.");
      const update = (event) => {
        const next = Number.isFinite(event.webkitCompassHeading) ? event.webkitCompassHeading : Number.isFinite(event.alpha) ? (360 - event.alpha + 360) % 360 : null;
        if (next !== null) setHeading(next);
      };
      window.addEventListener("deviceorientationabsolute", update, true);
      window.addEventListener("deviceorientation", update, true);
      setCompassEnabled(true);
    } catch (error) { setStatus((current) => ({ ...current, detail: error.message })); }
  }, []);

  const reset = useCallback(async () => {
    await storeQueue.current; await clearRecords();
    engine.current = { track: new FlightTrack(), mesh: new MeshNetwork(), framer: new PacketFramer(), trackedNode: null };
    setPoint(null); setTrackPoints([]); setPrediction([]); setGroundStations([]); setMesh({ nodes: [], health: null });
    setRawLines([]); setRejectedCount(0); setLastPacketAt(null);
    setStatus((current) => ({ ...current, detail: current.connected ? "Telemetry cleared. Waiting for the next packet." : "Telemetry cleared. Connect the ground station to start a new log." }));
  }, []);

  useEffect(() => {
    const support = transportSupport();
    if (!window.isSecureContext) { setTransportAvailable(false); setStatus({ connected: false, mode: null, detail: "HTTPS is required for USB and GPS access." }); }
    else if (!support.available) { setTransportAvailable(false); setStatus({ connected: false, mode: null, detail: "Use Chrome or Edge. Android uses the WebUSB fallback." }); }
    else setStatus({ connected: false, mode: null, detail: `${support.mode} ready. Connect the board when you are ready.` });
    loadRecords().then((records) => {
      setRawLines(records.filter((record) => record.record === "raw").slice(-5000).map((record) => record.raw));
      setRejectedCount(records.filter((record) => record.record === "rejected").length);
      setLastPacketAt(records.filter((record) => record.record === "telemetry").at(-1)?.point?.receivedAt || null);
    }).catch(() => {});
    const interval = setInterval(() => { refreshMesh(); shareLocation(); }, 10000);
    return () => { clearInterval(interval); if (locationWatch.current !== null) navigator.geolocation?.clearWatch(locationWatch.current); connection.current?.disconnect(); };
  }, [refreshMesh, shareLocation]);

  const faults = useMemo(() => point ? decodeFaults(point.flags, { legacy: point.faultEncoding === "uint32" }).filter((item) => item.fault) : [], [point]);
  const value = { status, transportAvailable, point, trackPoints, prediction, groundStations, mesh, rawLines, rejectedCount, lastPacketAt, userLocation, heading, baudRate, locating, compassEnabled, faults, velocity: engine.current.track.velocity, toggleConnection, setBaudRate, useDeviceLocation, useManualLocation, enableCompass, reset, exportRawLog: async () => { await storeQueue.current; await exportRawLog(); } };
  return <TrackerContext.Provider value={value}>{children}</TrackerContext.Provider>;
}

export function useTracker() {
  const value = useContext(TrackerContext);
  if (!value) throw new Error("useTracker must be used inside TrackerProvider");
  return value;
}
