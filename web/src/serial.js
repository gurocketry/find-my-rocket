import { serial as webUsbSerial } from "web-serial-polyfill";

const ASTRA_FILTERS = [{ usbVendorId: 0x1eaf, usbProductId: 0x0003 }];

export function transportSupport() {
  if ("serial" in navigator) return { available: true, mode: "Web Serial" };
  if ("usb" in navigator) return { available: true, mode: "WebUSB serial" };
  return { available: false, mode: "Unsupported browser" };
}

export class SerialConnection extends EventTarget {
  constructor(baudRate = 115200) {
    super();
    this.baudRate = baudRate;
    this.api = "serial" in navigator ? navigator.serial : webUsbSerial;
    this.mode = "serial" in navigator ? "Web Serial" : "WebUSB serial";
    this.port = null;
    this.reader = null;
    this.reading = false;
  }

  async connect() {
    this.port = await this.api.requestPort({ filters: ASTRA_FILTERS });
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
