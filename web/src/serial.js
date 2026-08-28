import { serial as webUsbSerial } from "web-serial-polyfill";

export function transportSupport(nav = navigator) {
  const android = nav.userAgentData?.platform === "Android" || /Android/i.test(nav.userAgent || "");
  if (android && "usb" in nav) return { available: true, mode: "WebUSB serial" };
  if ("serial" in nav) return { available: true, mode: "Web Serial" };
  if ("usb" in nav) return { available: true, mode: "WebUSB serial" };
  return { available: false, mode: "Unsupported browser" };
}

export async function requestWebUsbPort(usb = navigator.usb, serial = webUsbSerial) {
  // An empty WebUSB filter object matches every non-blocklisted USB device.
  // This avoids the polyfill's implicit classCode: 2 chooser filter, which can
  // hide STM32 CDC firmware on Android before the user grants permission.
  const selected = await usb.requestDevice({ filters: [{}] });
  const ports = await serial.getPorts();
  const port = ports.find((candidate) => {
    const info = candidate.getInfo();
    return info.usbVendorId === selected.vendorId && info.usbProductId === selected.productId;
  });

  if (!port) {
    const id = `${selected.vendorId.toString(16).padStart(4, "0")}:${selected.productId.toString(16).padStart(4, "0")}`;
    throw new Error(`USB device ${id} was selected, but it does not expose standard CDC-ACM control and data interfaces.`);
  }
  return port;
}

export class SerialConnection extends EventTarget {
  constructor(baudRate = 115200) {
    super();
    this.baudRate = baudRate;
    this.mode = transportSupport().mode;
    this.port = null;
    this.reader = null;
    this.reading = false;
  }

  async connect() {
    this.port = this.mode === "WebUSB serial"
      ? await requestWebUsbPort()
      : await navigator.serial.requestPort();
    await this.port.open({ baudRate: this.baudRate, bufferSize: 4096 });
    this.reading = true;
    this.dispatchEvent(new CustomEvent("status", { detail: { connected: true, mode: this.mode } }));
    this.#readLoop();
  }

  async #readLoop() {
    const decoder = new TextDecoder();
    while (this.port?.readable && this.reading) {
      this.reader = this.port.readable.getReader();
      try {
        while (this.reading) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this.dispatchEvent(new CustomEvent("data", { detail: decoder.decode(value, { stream: true }) }));
        }
      } catch (error) {
        this.dispatchEvent(new CustomEvent("recoverable-error", { detail: error }));
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
    }
    this.reading = false;
    this.dispatchEvent(new CustomEvent("status", { detail: { connected: false, mode: this.mode } }));
  }

  async disconnect() {
    this.reading = false;
    if (this.reader) await this.reader.cancel().catch(() => {});
    if (this.port) await this.port.close().catch(() => {});
    this.port = null;
  }
}
