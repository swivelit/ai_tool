import { describe, expect, it } from "vitest";
import { SwicoSSEParser } from "../lib/swicoStream";
import { emptySwicoStreamState, reduceSwicoStream, type SwicoStreamState } from "../lib/swicoChatReducer";

describe("Swico streaming transport", () => {
  it("parses SSE frames split across arbitrary network chunks", () => {
    const parser = new SwicoSSEParser();
    expect(parser.push('event: delta\ndata: {"text":"hel')).toEqual([]);
    expect(parser.push('lo"}\n\nevent: status\ndata: {"phase":"generating"}\n\n')).toEqual([
      { event: "delta", data: { text: "hello" } },
      { event: "status", data: { phase: "generating" } },
    ]);
    expect(parser.push('event: done\ndata: {"finish_reason":"stop"}\n')).toEqual([]);
    expect(parser.finish()).toEqual([{ event: "done", data: { finish_reason: "stop" } }]);
  });

  it("keeps incremental text, queue status, usage, and completion metadata", () => {
    let state: SwicoStreamState = { ...emptySwicoStreamState, assistant: { id: "a", thread_id: "t", role: "assistant" as const, content: "", request_id: "r", tier: "free" as const, tier_label: "Swico Free", input_tokens: 0, output_tokens: 0, usage_source: null, charge_micros: 0, status: "streaming", created_at: "", input_mode: "text" as const, voice_turn_id: null, reply_language: null } };
    state = reduceSwicoStream(state, { event: "status", data: { phase: "queued", queue_position: 2, estimated_wait_seconds: 18 } });
    state = reduceSwicoStream(state, { event: "delta", data: { text: "Hello" } });
    state = reduceSwicoStream(state, { event: "usage", data: { input_tokens: 4, output_tokens: 1, tier: "free", tier_label: "Swico Free", usage_source: "actual", charged_micros: 0 } });
    state = reduceSwicoStream(state, { event: "done", data: { message_id: "m1", finish_reason: "length", truncated: true, can_continue: true } });
    expect(state.queuePosition).toBe(2);
    expect(state.assistant?.content).toBe("Hello");
    expect(state.assistant?.truncated).toBe(true);
    expect(state.assistant?.can_continue).toBe(true);
    expect(state.done).toBe(true);
  });

  it("normalizes CRLF frames split across chunks", () => {
    const parser = new SwicoSSEParser();
    expect(parser.push("event: delta\r\ndata: {\"text\":\"a\"}\r\n\r\n" )).toEqual([{ event: "delta", data: { text: "a" } }]);
    expect(parser.push("event: done\r\ndata: {\"finish_reason\":\"stop\"}\r\n\r\n")).toEqual([{ event: "done", data: { finish_reason: "stop" } }]);
  });

  it("stitches continuation markdown without duplicating the boundary", async () => {
    const { stitchContinuationMarkdown } = await import("../lib/continuationMarkdown");
    expect(stitchContinuationMarkdown([{ content: "one" }, { content: "two", continuation_rewind_characters: 0 }])).toBe("one\ntwo");
    expect(stitchContinuationMarkdown([{ content: "one two" }, { content: "three", continuation_rewind_characters: 3 }])).toBe("one three");
  });
});
