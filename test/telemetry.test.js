import test from "node:test";
import assert from "node:assert/strict";
import {
  FlightTrack, MeshNetwork, PacketFramer, bearingDegrees, decodeFaults, parseHealthLine, parsePackets,
} from "../src/telemetry.js";

test("parses Astra telemetry with and without timestamps", () => {
  const first = parsePackets("19:02:56.588 > 0, 00000001, 55.870758, -4.286921, 45.0, -31, 9");
  const second = parsePackets("1, 00000002, 55.870858, -4.286821, 65.0, -32, 10");
  assert.equal(first.packets[0].timestamp, "19:02:56.588");
  assert.equal(second.packets[0].stage, 1);
});

test("resynchronises after a broken packet", () => {
  const result = parsePackets(
    "12:00:00.000 > 1, broken" +
    "12:00:01.000 > 1, 00000002, 55.870758, -4.286921, 120.5, -72, 9",
  );
  assert.equal(result.packets.length, 1);
  assert.equal(result.packets[0].timestamp, "12:00:01.000");
  assert.equal(result.rejected.length, 1);
});

test("recovers concatenated packets without newlines", () => {
  const result = parsePackets(
    "0, 00000001, 55.870758, -4.286921, 45.0, -70, 9" +
    "1, 00000002, 55.870858, -4.286821, 65.0, -71, 10",
  );
  assert.equal(result.packets.length, 2);
});

test("parses the new ground-station flight and ground packet formats", () => {
  const flight = parsePackets("[0-42] [flight] 2, 10000000, 55.870758, -4.286921, 120.50");
  const ground = parsePackets("[3-7] 55.871000, -4.287000, 48.25");

  assert.deepEqual(flight.rejected, []);
  assert.equal(flight.packets[0].kind, "flight");
  assert.equal(flight.packets[0].sender, 0);
  assert.equal(flight.packets[0].sequence, 42);
  assert.equal(flight.packets[0].stage, 2);
  assert.equal(ground.packets[0].kind, "ground");
  assert.equal(ground.packets[0].sender, 3);
  assert.equal(ground.packets[0].alt, 48.25);
  assert.equal(parsePackets("[4-8] 0.000000, 0.000000, 0.00").packets[0].kind, "ground");
});

test("keeps compatibility with the preceding sender(sequence) packet format", () => {
  assert.equal(
    parsePackets("0(42): 2, 10000000, 55.870758, -4.286921, 120.50").packets[0].kind,
    "flight",
  );
});

test("decodes current Astra packed device faults in registry order", () => {
  const statuses = decodeFaults("11321142");
  assert.deepEqual(statuses.map(({ name, status }) => [name, status]), [
    ["LED", "ready"],
    ["Radio", "ready"],
    ["Flash storage", "undetected"],
    ["Accelerometer", "power failure"],
    ["Barometer", "ready"],
    ["GPS", "ready"],
    ["Gyroscope", "device ID failure"],
    ["Magnetometer", "configuration error"],
  ]);
  assert.deepEqual(statuses.filter(({ fault }) => fault).map(({ name }) => name), [
    "Flash storage", "Accelerometer", "Gyroscope", "Magnetometer",
  ]);
});

test("decodes legacy uint32 fault text from least-significant nibble first", () => {
  const statuses = decodeFaults("43211111", { legacy: true });
  assert.equal(statuses[0].status, "ready");
  assert.equal(statuses[5].status, "no fix");
  assert.equal(statuses[7].status, "configuration error");
});

test("parses ground-station network health output", () => {
  const health = parseHealthLine(
    "[health] rssi=-72 avg_rssi=-75 snr=8 avg_snr=7 rx=12 accepted=8 rejected=4 duplicates=3 queue=1 queue_drops=0 relayed=7 mesh=active mesh_rx_age_ms=22",
    new Date("2026-08-25T12:00:00Z"),
  );
  assert.equal(health.avg_rssi, -75);
  assert.equal(health.accepted, 8);
  assert.equal(health.mesh, "active");
  assert.equal(health.receivedAt, "2026-08-25T12:00:00.000Z");
});

test("parses the new positional CSV network health output", () => {
  const health = parseHealthLine(
    "[health]-72, -75, 8, 7, 12, 8, 4, 1, 3, 1, 0, 7, 2, 5, 1, active, 22, 40",
  );
  assert.equal(health.rssi, -72);
  assert.equal(health.avg_rssi, -75);
  assert.equal(health.rx, 12);
  assert.equal(health.relay_failures, 2);
  assert.equal(health.mesh, "active");
  assert.equal(health.mesh_rx_age_ms, 22);
  assert.equal(health.mesh_age_ms, 40);
});

test("accepts never values and an optional CSV delimiter after health prefix", () => {
  const health = parseHealthLine(
    "[health], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, never, never, never",
  );
  assert.equal(health.mesh, "never");
  assert.equal(health.mesh_rx_age_ms, "never");
});

test("rejects truncated positional health rows", () => {
  assert.equal(parseHealthLine("[health]-72, -75, 8"), null);
});

test("tracks packet totals, duplicates and sequence gaps for every mesh node", () => {
  const mesh = new MeshNetwork();
  const packet = { kind: "ground", sender: 3, sequence: 10, lat: 55, lon: -4, alt: 20 };
  mesh.observe(packet);
  mesh.observe({ ...packet, sequence: 10 });
  mesh.observe({ ...packet, sequence: 13 });

  const node = mesh.snapshot()[0];
  assert.equal(node.packets, 3);
  assert.equal(node.uniquePackets, 2);
  assert.equal(node.duplicates, 1);
  assert.equal(node.missedPackets, 2);
  assert.equal(node.lastSequence, 13);
});

test("framer accepts CR, LF and chunked input", () => {
  const framer = new PacketFramer();
  assert.deepEqual(framer.push("one\rtw").lines, ["one"]);
  assert.deepEqual(framer.push("o\nthree\r\n").lines, ["two", "three"]);
});

test("frames and parses a realistically chunked current ground-station stream", () => {
  const framer = new PacketFramer();
  const chunks = [
    "[0-42] [flight] 2, 10000000, 55.870758, -4.286921, 120.50\r",
    "\n[3-7] 55.871000, -4.287000, 48.25\r\n[health]-72, -75, 8, 7, 12, ",
    "8, 4, 1, 3, 1, 0, 7, 2, 5, 1, active, 22, 40\n",
  ];
  const lines = chunks.flatMap((chunk) => framer.push(chunk).lines);
  const flight = parsePackets(lines[0]).packets[0];
  const ground = parsePackets(lines[1]).packets[0];
  const health = parseHealthLine(lines[2]);

  assert.equal(flight.sender, 0);
  assert.equal(flight.sequence, 42);
  assert.equal(flight.kind, "flight");
  assert.equal(ground.sender, 3);
  assert.equal(ground.kind, "ground");
  assert.equal(health.rx, 12);
  assert.equal(health.mesh, "active");
});

test("flight state derives velocity and prediction in JavaScript", () => {
  const track = new FlightTrack();
  [45, 45, 47, 62, 90].forEach((alt, second) => track.add({
    stage: second > 2 ? 1 : 0, flags: "0", lat: 55.87 + second * 0.00001,
    lon: -4.29 + second * 0.00001, alt, rssi: -70, sats: 10,
    timestamp: `12:00:0${second}.000`, raw: "test",
  }));
  assert.equal(track.launched, true);
  assert.ok(track.velocity.vertical > 5);
  assert.ok(track.prediction().length > 0);
});

test("calculates initial compass bearings", () => {
  const origin = { lat: 0, lon: 0 };
  assert.ok(Math.abs(bearingDegrees(origin, { lat: 1, lon: 0 })) < 0.001);
  assert.ok(Math.abs(bearingDegrees(origin, { lat: 0, lon: 1 }) - 90) < 0.001);
  assert.ok(Math.abs(bearingDegrees(origin, { lat: -1, lon: 0 }) - 180) < 0.001);
});
