const EARTH_RADIUS_M = 6_371_000;
const GRAVITY_M_S2 = 9.80665;

export const STAGES = new Map([
  [0, "PAD"],
  [1, "BURNING"],
  [2, "COASTING"],
  [3, "DESCENT"],
  [4, "LANDED"],
  [255, "UNKNOWN"],
]);

const PACKET_SOURCE = String.raw`(?:(\d{2}:\d{2}:\d{2}\.\d{3})\s*>\s*)?((?:[0-4]|255))\s*,\s*([0-9a-fA-F]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*(-?\d+)\s*,\s*(\d+?)`;
const NEXT_PACKET = String.raw`(?=\s*(?:(?:\d{2}:\d{2}:\d{2}\.\d{3}\s*>\s*)?(?:[0-4]|255)\s*,\s*[0-9a-fA-F]+\s*,\s*[-\d.]+\s*,|$))`;
const MESH_PACKET_RE = /^(?:(\d{2}:\d{2}:\d{2}\.\d{3})\s*>\s*)?(?:(\d{1,3})\((\d{1,5})\):|\[(\d{1,3})-(\d{1,5})\])\s*(\[flight\]\s*)?(.+?)\s*$/;
const HEALTH_RE = /^\[health\]\s*,?\s*(.+)$/;
const HEALTH_FIELDS = [
  "rssi", "avg_rssi", "snr", "avg_snr", "rx", "accepted", "rejected", "invalid",
  "duplicates", "queue", "queue_drops", "relayed", "relay_failures", "pings",
  "ping_failures", "mesh", "mesh_rx_age_ms", "mesh_age_ms",
];

function packetRegex() {
  return new RegExp(PACKET_SOURCE + NEXT_PACKET, "g");
}

export function clockSeconds(value) {
  const [hours, minutes, seconds] = value.split(":");
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export function parsePackets(raw) {
  const meshMatch = raw.trim().match(MESH_PACKET_RE);
  if (meshMatch) {
    const [, timestamp, oldSender, oldSequence, newSender, newSequence, flightMarker, payloadText] = meshMatch;
    const senderText = oldSender ?? newSender;
    const sequenceText = oldSequence ?? newSequence;
    const sender = Number(senderText);
    const sequence = Number(sequenceText);
    const fields = payloadText.split(",").map((field) => field.trim());
    let packet = null;

    if (!flightMarker && fields.length === 3) {
      const [lat, lon, alt] = fields.map(Number);
      packet = {
        kind: "ground", sender, sequence, timestamp: timestamp || null,
        lat, lon, alt, stage: null, flags: null, rssi: null, sats: null, raw: meshMatch[0],
      };
    } else if (fields.length === 5) {
      const [stage, flags, lat, lon, alt] = fields;
      packet = {
        kind: "flight", sender, sequence, timestamp: timestamp || null,
        stage: Number(stage), flags, lat: Number(lat), lon: Number(lon), alt: Number(alt),
        rssi: null, sats: null, raw: meshMatch[0],
      };
    }

    const valid = packet && sender >= 0 && sender <= 15 && sequence >= 0 && sequence <= 65535 &&
      Number.isFinite(packet.lat) && packet.lat >= -90 && packet.lat <= 90 &&
      Number.isFinite(packet.lon) && packet.lon >= -180 && packet.lon <= 180 &&
      Number.isFinite(packet.alt) && (packet.kind === "ground" || !(packet.lat === 0 && packet.lon === 0)) &&
      (packet.kind === "ground" || STAGES.has(packet.stage));
    return valid ? { packets: [packet], rejected: [] } : { packets: [], rejected: [raw.trim()] };
  }

  const packets = [];
  const rejected = [];
  const regex = packetRegex();
  let consumed = 0;
  let match;

  while ((match = regex.exec(raw)) !== null) {
    if (match.index > consumed && raw.slice(consumed, match.index).trim()) {
      rejected.push(raw.slice(consumed, match.index).trim());
    }
    consumed = regex.lastIndex;
    const [, timestamp, stage, flags, lat, lon, alt, rssi, sats] = match;
    const packet = {
      kind: "flight",
      sender: null,
      sequence: null,
      timestamp: timestamp || null,
      stage: Number(stage),
      flags,
      lat: Number(lat),
      lon: Number(lon),
      alt: Number(alt),
      rssi: Number(rssi),
      sats: Number(sats),
      raw: match[0],
    };

    if (
      !STAGES.has(packet.stage) ||
      !Number.isFinite(packet.lat) || packet.lat < -90 || packet.lat > 90 ||
      !Number.isFinite(packet.lon) || packet.lon < -180 || packet.lon > 180 ||
      !Number.isFinite(packet.alt) ||
      packet.sats < 0 || packet.sats > 255 ||
      (packet.lat === 0 && packet.lon === 0)
    ) {
      rejected.push(match[0]);
    } else {
      packets.push(packet);
    }
  }

  if (consumed < raw.length && raw.slice(consumed).trim()) {
    rejected.push(raw.slice(consumed).trim());
  }
  return { packets, rejected };
}

export function parseHealthLine(raw, receivedAt = new Date()) {
  const match = raw.trim().match(HEALTH_RE);
  if (!match) return null;
  const health = { receivedAt: receivedAt.toISOString() };
  const parseValue = (value) => /^-?\d+$/.test(value) ? Number(value) : value;

  if (match[1].includes("=")) {
    for (const field of match[1].matchAll(/([a-z_]+)=([^\s]+)/g)) {
      health[field[1]] = parseValue(field[2]);
    }
  } else {
    const values = match[1].split(",").map((value) => value.trim());
    if (values.length !== HEALTH_FIELDS.length) return null;
    HEALTH_FIELDS.forEach((field, index) => {
      health[field] = parseValue(values[index]);
    });
  }
  return health;
}

export class MeshNetwork {
  constructor() {
    this.nodes = new Map();
    this.health = null;
  }

  observe(packet, receivedAt = new Date()) {
    if (packet.sender === null || packet.sender === undefined) return null;
    const node = this.nodes.get(packet.sender) || {
      id: packet.sender,
      kind: packet.kind,
      packets: 0,
      uniquePackets: 0,
      duplicates: 0,
      missedPackets: 0,
      lastSequence: null,
      lastSeen: null,
      position: null,
    };
    node.kind = packet.kind;
    node.packets += 1;
    let duplicate = false;
    if (node.lastSequence === null) {
      node.uniquePackets += 1;
      node.lastSequence = packet.sequence;
    } else {
      const forward = (packet.sequence - node.lastSequence + 65536) % 65536;
      if (forward === 0 || forward > 32768) {
        node.duplicates += 1;
        duplicate = true;
      } else {
        node.uniquePackets += 1;
        node.missedPackets += Math.max(0, forward - 1);
        node.lastSequence = packet.sequence;
      }
    }
    node.lastSeen = receivedAt.toISOString();
    if (packet.lat !== 0 || packet.lon !== 0) {
      node.position = { lat: packet.lat, lon: packet.lon, alt: packet.alt };
    }
    this.nodes.set(packet.sender, node);
    return { node, duplicate };
  }

  updateHealth(health) {
    this.health = health;
  }

  snapshot() {
    return [...this.nodes.values()].sort((a, b) => a.id - b.id);
  }
}

export class PacketFramer {
  constructor({ maxBuffer = 8192 } = {}) {
    this.buffer = "";
    this.maxBuffer = maxBuffer;
  }

  push(text) {
    this.buffer += text.replace(/\r\n?/g, "\n");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    const rejected = [];

    if (this.buffer.length > this.maxBuffer) {
      rejected.push(this.buffer.slice(0, -512));
      this.buffer = this.buffer.slice(-512);
    }
    return { lines: lines.filter((line) => line.trim()), rejected };
  }

  flush() {
    const tail = this.buffer;
    this.buffer = "";
    return tail;
  }
}

function offsetLocation(lat, lon, northM, eastM) {
  return {
    lat: lat + (northM / EARTH_RADIUS_M) * (180 / Math.PI),
    lon: lon + (eastM / (EARTH_RADIUS_M * Math.cos(lat * Math.PI / 180))) * (180 / Math.PI),
  };
}

export function distanceMetres(a, b) {
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function bearingDegrees(a, b) {
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export class FlightTrack {
  constructor(limit = 10000) {
    this.limit = limit;
    this.points = [];
    this.groundAltitude = null;
    this.launched = false;
    this.launchTime = null;
    this.velocity = { north: 0, east: 0, vertical: 0, speed: 0 };
  }

  add(packet, receivedAt = new Date()) {
    const timestamp = packet.timestamp || receivedAt.toISOString().slice(11, 23);
    const point = {
      ...packet,
      timestamp,
      elapsed: packet.timestamp ? clockSeconds(packet.timestamp) : receivedAt.getTime() / 1000,
      receivedAt: receivedAt.toISOString(),
    };
    if (this.groundAltitude === null) this.groundAltitude = point.alt;
    this.points.push(point);
    if (this.points.length > this.limit) this.points.shift();
    this.#updateVelocity();
    return point;
  }

  #updateVelocity() {
    if (this.points.length < 2) return;
    const newest = this.points.at(-1);
    const oldest = this.points.at(-Math.min(5, this.points.length));
    let dt = newest.elapsed - oldest.elapsed;
    if (dt < 0) dt += 86400;
    if (dt <= 0) return;
    const north = (newest.lat - oldest.lat) * Math.PI / 180 * EARTH_RADIUS_M;
    const east = (newest.lon - oldest.lon) * Math.PI / 180 * EARTH_RADIUS_M * Math.cos(newest.lat * Math.PI / 180);
    const vertical = (newest.alt - oldest.alt) / dt;
    this.velocity = {
      north: north / dt,
      east: east / dt,
      vertical,
      speed: Math.hypot(north / dt, east / dt, vertical),
    };
    if (!this.launched && this.points.length >= 4 && newest.alt - this.groundAltitude >= 15 && vertical >= 5) {
      this.launched = true;
      this.launchTime = newest.timestamp;
    }
  }

  prediction() {
    if (!this.launched || !this.points.length) return [];
    const last = this.points.at(-1);
    const result = [];
    for (let second = 1; second <= 120; second += 1) {
      const alt = last.alt + this.velocity.vertical * second - 0.5 * GRAVITY_M_S2 * second ** 2;
      if (alt <= this.groundAltitude) break;
      result.push({
        ...offsetLocation(last.lat, last.lon, this.velocity.north * second, this.velocity.east * second),
        alt,
        second,
      });
    }
    return result;
  }
}
