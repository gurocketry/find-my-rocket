export function enteredLanded(previousStage, nextStage) {
  return previousStage !== undefined && previousStage !== 4 && nextStage === 4;
}

export class AudioCues {
  constructor(Context = globalThis.AudioContext || globalThis.webkitAudioContext) {
    this.Context = Context;
    this.context = null;
  }

  async enable() {
    if (!this.Context) return false;
    this.context ||= new this.Context();
    if (this.context.state === "suspended") await this.context.resume();
    return this.context.state === "running";
  }

  meow() {
    if (this.context?.state !== "running") return;
    const now = this.context.currentTime;
    const voice = this.context.createOscillator();
    const overtone = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();

    voice.type = "sawtooth";
    overtone.type = "triangle";
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(950, now);
    filter.Q.setValueAtTime(1.4, now);
    voice.frequency.setValueAtTime(520, now);
    voice.frequency.exponentialRampToValueAtTime(720, now + 0.11);
    voice.frequency.exponentialRampToValueAtTime(390, now + 0.34);
    overtone.frequency.setValueAtTime(780, now);
    overtone.frequency.exponentialRampToValueAtTime(1080, now + 0.11);
    overtone.frequency.exponentialRampToValueAtTime(585, now + 0.34);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.055, now + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);

    voice.connect(filter);
    overtone.connect(filter);
    filter.connect(gain);
    gain.connect(this.context.destination);
    voice.start(now);
    overtone.start(now);
    voice.stop(now + 0.38);
    overtone.stop(now + 0.38);
  }

  boing() {
    if (this.context?.state !== "running") return;
    const now = this.context.currentTime;
    const voice = this.context.createOscillator();
    const overtone = this.context.createOscillator();
    const gain = this.context.createGain();

    voice.type = "sine";
    overtone.type = "triangle";
    voice.frequency.setValueAtTime(260, now);
    voice.frequency.exponentialRampToValueAtTime(72, now + 0.7);
    overtone.frequency.setValueAtTime(390, now);
    overtone.frequency.exponentialRampToValueAtTime(108, now + 0.7);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.11, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);

    voice.connect(gain);
    overtone.connect(gain);
    gain.connect(this.context.destination);
    voice.start(now);
    overtone.start(now);
    voice.stop(now + 0.78);
    overtone.stop(now + 0.78);
  }
}
