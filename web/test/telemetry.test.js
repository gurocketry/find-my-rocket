import test from "node:test";
import assert from "node:assert/strict";
import { FlightTrack, PacketFramer, parsePackets } from "../src/telemetry.js";

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

test("framer accepts CR, LF and chunked input", () => {
  const framer = new PacketFramer();
  assert.deepEqual(framer.push("one\rtw").lines, ["one"]);
  assert.deepEqual(framer.push("o\nthree\r\n").lines, ["two", "three"]);
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
