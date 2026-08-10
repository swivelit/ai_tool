import { describe, expect, it } from "vitest";
import { validateRealtimeAudioStart } from "../lib/swicoRealtimeVoice";

describe("canonical realtime voice audio contract", () => {
  it("accepts buffered MP3 output", () => {
    expect(validateRealtimeAudioStart({ protocol_version: 1, type: "audio.start", content_type: "audio/mpeg", codec: "mp3", sample_rate: null, channels: 1, sample_format: null, playback_mode: "buffered_mp3", turn_number: 1 })).toMatchObject({ ok: true });
  });

  it("accepts native linear16 PCM output at a supported rate", () => {
    expect(validateRealtimeAudioStart({ protocol_version: 1, type: "audio.start", content_type: "audio/L16", codec: "linear16", sample_rate: 24000, channels: 1, sample_format: "pcm_s16le", playback_mode: "pcm_stream", turn_number: 2 })).toMatchObject({ ok: true, value: { codec: "linear16", sample_rate: 24000 } });
  });

  it.each([
    { content_type: "audio/mpeg", codec: "linear16", sample_rate: 24000, sample_format: "pcm_s16le", playback_mode: "pcm_stream" },
    { content_type: "audio/L16", codec: "linear16", sample_rate: 44100, sample_format: "pcm_s16le", playback_mode: "pcm_stream" },
    { content_type: "audio/mpeg", codec: "mp3", sample_rate: 24000, sample_format: null, playback_mode: "buffered_mp3" },
    { content_type: "audio/mpeg", codec: "mp3", sample_rate: null, channels: 2, sample_format: null, playback_mode: "buffered_mp3" },
  ])("rejects malformed or unsupported audio.start %#", input => {
    expect(validateRealtimeAudioStart({ protocol_version: 1, type: "audio.start", channels: 1, turn_number: 1, ...input })).toMatchObject({ ok: false });
  });
});
