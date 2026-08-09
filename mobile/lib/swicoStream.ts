import type { StreamEvent } from "./swicoTypes";

/** Incremental SSE parser shared by fetch and React Native XHR transports. */
export class SwicoSSEParser {
  private buffer = "";

  push(chunk: string): StreamEvent[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events: StreamEvent[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const event = this.parse(frame);
      if (event) events.push(event);
      boundary = this.buffer.indexOf("\n\n");
    }
    return events;
  }

  finish(): StreamEvent[] {
    if (!this.buffer.trim()) return [];
    const event = this.parse(this.buffer);
    this.buffer = "";
    return event ? [event] : [];
  }

  private parse(frame: string): StreamEvent | null {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      if (field === "data") data.push(value);
    }
    if (!data.length) return null;
    const raw = data.join("\n");
    try {
      return { event, data: JSON.parse(raw) as unknown };
    } catch {
      return { event, data: raw };
    }
  }
}

export function parseSwicoSSEChunk(parser: SwicoSSEParser, chunk: string) {
  return parser.push(chunk);
}
