import { Platform } from "react-native";
import { EventEmitter, requireNativeModule, type EventSubscription } from "expo-modules-core";
import { SWICO_API_BASE } from "./swicoApi";
import type { RealtimeVoiceSession } from "./swicoTypes";

type NativeRealtimeModule = {
  startRealtimePcm: (config: { sampleRate: number; frameSamples: number }) => Promise<Record<string, unknown>>;
  stopRealtimePcm: () => Promise<Record<string, unknown>>;
  getRealtimePcmStatus: () => Promise<Record<string, unknown>>;
};
export type PcmFrame = { encoding: "pcm_s16le"; sampleRate: number; frameSamples: number; sequence: number; data: ArrayBuffer };
export type RealtimeVoiceCallbacks = { onJson?: (message: Record<string, unknown>) => void; onAudio?: (packet: ArrayBuffer) => void; onError?: (message: string) => void; onClose?: () => void };

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
