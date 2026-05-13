import { describe, expect, it, vi } from "vitest";

import {
  EMPTY_AUDIO_MESSAGE,
  MIC_START_TIMEOUT_MESSAGE,
  RecordingStartTimeoutError,
  assertUsableAudioFile,
  withRecordingStartTimeout,
} from "@/lib/voiceRecording";

describe("voice recording helpers", () => {
  it("times out recording startup cleanly", async () => {
    vi.useFakeTimers();
    const pending = new Promise<void>(() => undefined);
    const result = withRecordingStartTimeout(pending, 25);
    const expectation = expect(result).rejects.toThrow(MIC_START_TIMEOUT_MESSAGE);

    await vi.advanceTimersByTimeAsync(25);

    await expectation;
    await expect(result).rejects.toBeInstanceOf(RecordingStartTimeoutError);
    vi.useRealTimers();
  });

  it("rejects empty audio before upload", async () => {
    const fileSystem = {
      getInfoAsync: vi.fn(async () => ({ exists: true, size: 0 })),
    };

    await expect(
      assertUsableAudioFile("file:///tmp/audio.m4a", fileSystem as any),
    ).rejects.toThrow(EMPTY_AUDIO_MESSAGE);
    expect(fileSystem.getInfoAsync).toHaveBeenCalledWith("file:///tmp/audio.m4a");
  });

  it("accepts non-empty audio before upload", async () => {
    const fileSystem = {
      getInfoAsync: vi.fn(async () => ({ exists: true, size: 42 })),
    };

    await expect(
      assertUsableAudioFile("file:///tmp/audio.m4a", fileSystem as any),
    ).resolves.toEqual({ exists: true, size: 42 });
  });
});
