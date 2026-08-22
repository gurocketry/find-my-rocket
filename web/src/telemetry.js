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

function packetRegex() {
  return new RegExp(PACKET_SOURCE + NEXT_PACKET, "g");
}

export function clockSeconds(value) {
  const [hours, minutes, seconds] = value.split(":");
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export function parsePackets(raw) {
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
