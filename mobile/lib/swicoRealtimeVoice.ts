import { Platform } from "react-native";
import { EventEmitter, requireNativeModule, type EventSubscription } from "expo-modules-core";
import { SWICO_API_BASE } from "./swicoApi";
import type { RealtimeVoiceSession } from "./swicoTypes";

type NativeRealtimeModule = {
  startRealtimePcm: (config: { sampleRate: number; frameSamples: number }) => Promise<Record<string, unknown>>;
  stopRealtimePcm: () => Promise<Record<string, unknown>>;
  getRealtimePcmStatus: () => Promise<Record<string, unknown>>;
  startRealtimePcmPlayback: (config: { sampleRate: number }) => Promise<Record<string, unknown>>;
  writeRealtimePcmPlayback: (base64: string) => Promise<Record<string, unknown>>;
  stopRealtimePcmPlayback: () => Promise<Record<string, unknown>>;
};
export type PcmFrame = { encoding: "pcm_s16le"; sampleRate: number; frameSamples: number; sequence: number; data: ArrayBuffer };
export type RealtimeVoiceCallbacks = { onJson?: (message: Record<string, unknown>) => void; onAudio?: (packet: ArrayBuffer) => void; onError?: (message: string) => void; onClose?: () => void };
export type RealtimeAudioCodec = "mp3" | "linear16";
export type RealtimeAudioStart = { playback_mode: "buffered_mp3" | "pcm_stream" | "auto"; codec: RealtimeAudioCodec; content_type: string; sample_rate: number | null; channels: number; sample_format: string | null; turn_number: number };

let native: NativeRealtimeModule | null = null;
if (Platform.OS === "android") {
  try { native = requireNativeModule<NativeRealtimeModule>("JaiWakeWord"); } catch { native = null; }
}
const emitter: any = native ? new EventEmitter(native as any) : null;

function base64ToBuffer(value: string) {
  const clean = value.replace(/\s+/g, "");
  const decode = globalThis.atob || ((globalThis as unknown as { Buffer?: { from: (input: string, encoding: string) => Uint8Array } }).Buffer ? (input: string) => String.fromCharCode(...Array.from((globalThis as unknown as { Buffer: { from: (value: string, encoding: string) => Uint8Array } }).Buffer.from(input, "base64"))) : null);
  if (!decode) throw new Error("Realtime audio decoding is unavailable on this device.");
  const binary = decode(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export function realtimePcmAvailable() { return Platform.OS === "android" && Boolean(native); }
export function realtimePcmPlaybackAvailable() { return Platform.OS === "android" && Boolean(native); }

export function validateRealtimeAudioStart(message: Record<string, unknown>): { ok: true; value: RealtimeAudioStart } | { ok: false; reason: string } {
  const mode = message.playback_mode;
  const codec = message.codec;
  const mime = String(message.content_type ?? "");
  const sampleRate = message.sample_rate === null ? null : Number(message.sample_rate);
  const turnNumber = Number(message.turn_number);
  const baseValid = ["buffered_mp3", "pcm_stream", "auto"].includes(String(mode))
    && ["mp3", "linear16"].includes(String(codec))
    && message.channels === 1 && Number.isInteger(turnNumber) && turnNumber > 0;
  const mp3Valid = codec === "mp3" && mime === "audio/mpeg" && sampleRate === null && message.sample_format === null && mode !== "pcm_stream";
  const pcmValid = codec === "linear16" && mime === "audio/L16" && [8000, 16000, 22050, 24000].includes(sampleRate ?? 0)
    && message.sample_format === "pcm_s16le" && mode === "pcm_stream";
  if (!baseValid || (!mp3Valid && !pcmValid)) return { ok: false, reason: "The voice server returned an unsupported or malformed audio format." };
  return { ok: true, value: { playback_mode: mode as RealtimeAudioStart["playback_mode"], codec: codec as RealtimeAudioCodec, content_type: mime, sample_rate: sampleRate, channels: 1, sample_format: typeof message.sample_format === "string" ? message.sample_format : null, turn_number: turnNumber } };
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) binary += String.fromCharCode(...bytes.subarray(index, Math.min(bytes.length, index + chunkSize)));
  const encode = globalThis.btoa || ((globalThis as unknown as { Buffer?: { from: (input: string, encoding: string) => { toString: (encoding: string) => string } } }).Buffer ? (input: string) => (globalThis as unknown as { Buffer: { from: (value: string, encoding: string) => { toString: (encoding: string) => string } } }).Buffer.from(input, "binary").toString("base64") : null);
  if (!encode) throw new Error("Realtime audio encoding is unavailable on this device.");
  return encode(binary);
}

export async function startRealtimePcmPlayback(sampleRate: number) {
  if (!native) throw new Error("Realtime PCM playback is unavailable on this device.");
  await native.startRealtimePcmPlayback({ sampleRate });
}

let playbackWriteTail = Promise.resolve();
export function writeRealtimePcmPlayback(data: ArrayBuffer) {
  if (!native) return Promise.reject(new Error("Realtime PCM playback is unavailable on this device."));
  playbackWriteTail = playbackWriteTail.then(() => native!.writeRealtimePcmPlayback(bytesToBase64(new Uint8Array(data))).then(() => undefined));
  return playbackWriteTail;
}

export async function stopRealtimePcmPlayback() {
  playbackWriteTail = Promise.resolve();
  await native?.stopRealtimePcmPlayback();
}

export async function startRealtimePcm(onFrame: (frame: PcmFrame) => void, onError?: (message: string) => void): Promise<() => void> {
  if (!native || !emitter) throw new Error("Realtime voice is currently available on Android only.");
  const subscriptions: EventSubscription[] = [
    emitter.addListener("onRealtimePcmFrame" as any, (event: Record<string, unknown>) => {
      try {
        onFrame({ encoding: "pcm_s16le", sampleRate: Number(event.sampleRate || 16000), frameSamples: Number(event.frameSamples || 512), sequence: Number(event.sequence || 0), data: base64ToBuffer(String(event.base64 || "")) });
      } catch { onError?.("Realtime microphone data was invalid."); }
    }),
    emitter.addListener("onRealtimePcmError" as any, (event: Record<string, unknown>) => onError?.(String(event.message || "Realtime microphone stopped."))),
    emitter.addListener("onRealtimePcmStopped" as any, () => onError?.("Realtime microphone stopped.")),
  ];
  await native.startRealtimePcm({ sampleRate: 16000, frameSamples: 512 });
  return () => subscriptions.forEach(subscription => subscription.remove());
}

export async function stopRealtimePcm() { await native?.stopRealtimePcm(); }
export async function realtimePcmStatus() { return native?.getRealtimePcmStatus() || { running: false }; }

export class SwicoRealtimeVoiceTransport {
  private socket: WebSocket | null = null;
  private frameSubscription: (() => void) | null = null;
  private sequence = 0;
  constructor(private readonly session: RealtimeVoiceSession, private readonly callbacks: RealtimeVoiceCallbacks = {}) {}

  async connect(threadId?: string) {
    if (!realtimePcmAvailable()) throw new Error("Realtime voice is currently available on Android only.");
    const url = new URL(this.session.websocket_url);
    const apiUrl = new URL(SWICO_API_BASE);
    const allowedHosts = new Set(this.session.approved_websocket_hosts?.length ? this.session.approved_websocket_hosts : [apiUrl.host]);
    const expectedProtocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
    if (url.protocol !== expectedProtocol || url.pathname !== "/api/web/voice/ws" || !allowedHosts.has(url.host)) throw new Error("Realtime voice returned an unsafe connection target.");
    url.searchParams.set("ticket", this.session.ticket);
    const socket = new WebSocket(url.toString());
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onmessage = event => {
      if (typeof event.data === "string") {
        try { this.callbacks.onJson?.(JSON.parse(event.data) as Record<string, unknown>); } catch { /* ignore malformed server diagnostics */ }
      } else if (event.data instanceof ArrayBuffer) this.callbacks.onAudio?.(event.data);
    };
    socket.onerror = () => this.callbacks.onError?.("Realtime voice connection failed.");
    socket.onclose = () => { this.callbacks.onClose?.(); void stopRealtimePcm(); };
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("Realtime voice connection failed.")); });
    socket.send(JSON.stringify({ protocol_version: 1, type: "session.start", audio: { encoding: "pcm_s16le", sample_rate: 16000, channels: 1, frame_samples: 512 }, ...(threadId ? { thread_id: threadId } : {}) }));
    this.frameSubscription = await startRealtimePcm(frame => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      if (this.socket.bufferedAmount > 256 * 1024) return;
      const packet = new Uint8Array(4 + frame.data.byteLength);
      new DataView(packet.buffer).setUint32(0, ++this.sequence);
      packet.set(new Uint8Array(frame.data), 4);
      this.socket.send(packet);
    }, message => this.callbacks.onError?.(message));
  }

  mute(value: boolean) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ protocol_version: 1, type: value ? "mute" : "unmute" })); }
  ping() { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ protocol_version: 1, type: "ping" })); }
  async close() { this.frameSubscription?.(); this.frameSubscription = null; await stopRealtimePcm(); if (this.socket && this.socket.readyState < WebSocket.CLOSING) { this.socket.send(JSON.stringify({ protocol_version: 1, type: "session.close" })); this.socket.close(1000, "client_closed"); } this.socket = null; }
}
