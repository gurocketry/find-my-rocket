import test from "node:test";
import assert from "node:assert/strict";
import { SerialConnection, formatLocation, requestWebUsbPort, transportSupport } from "../src/serial.js";

test("forces Android onto the WebUSB transport", () => {
  assert.deepEqual(transportSupport({
    serial: {},
    usb: {},
    userAgent: "Mozilla/5.0 (Linux; Android 16)",
  }), { available: true, mode: "WebUSB serial" });
});

test("keeps native Web Serial on desktop", () => {
  assert.deepEqual(transportSupport({ serial: {}, usb: {}, userAgent: "Desktop" }), {
    available: true,
    mode: "Web Serial",
  });
});

test("Android chooser is unfiltered and returns the selected CDC port", async () => {
  const selected = { vendorId: 0x0483, productId: 0x5740 };
  let chooserOptions;
  const expectedPort = { getInfo: () => ({ usbVendorId: 0x0483, usbProductId: 0x5740 }) };
  const port = await requestWebUsbPort({
    requestDevice: async (options) => { chooserOptions = options; return selected; },
  }, {
    getPorts: async () => [
      { getInfo: () => ({ usbVendorId: 0x1eaf, usbProductId: 0x0003 }) },
      expectedPort,
    ],
  });

  assert.deepEqual(chooserOptions, { filters: [{}] });
  assert.equal(port, expectedPort);
});

test("reports a selected device with incompatible USB interfaces", async () => {
  await assert.rejects(() => requestWebUsbPort({
    requestDevice: async () => ({ vendorId: 0x0483, productId: 0x5740 }),
  }, {
    getPorts: async () => [],
  }), /0483:5740.*CDC-ACM/);
});

test("formats a phone fix as ground-station-compatible coordinates and a newline", () => {
  assert.equal(formatLocation(55.870758, -4.286921), "55.870758 -4.286921\n");
  assert.throws(() => formatLocation(91, 0), RangeError);
});

test("writes text to the connected serial port", async () => {
  const writes = [];
  let released = false;
  const connection = new SerialConnection(115200, "test");
  connection.reading = true;
  connection.port = {
    writable: {
      getWriter: () => ({
        write: async (bytes) => writes.push(new TextDecoder().decode(bytes)),
        releaseLock: () => { released = true; },
      }),
    },
  };

  await connection.write(formatLocation(55.870758, -4.286921));
  assert.deepEqual(writes, ["55.870758 -4.286921\n"]);
  assert.equal(released, true);
});
