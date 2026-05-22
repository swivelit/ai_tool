import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeChatResponse } from "../lib/chatResponse";

const chatSource = fs.readFileSync(
  path.join(__dirname, "..", "app", "(chat)", "index.tsx"),
  "utf8",
);
const transcriptSource = fs.readFileSync(
  path.join(__dirname, "..", "components", "VoiceSessionTranscript.tsx"),
  "utf8",
);

describe("voice-only file handling", () => {
  it("keeps typing controls available and does not expose composer voice controls", () => {
    expect(chatSource).toContain("voiceOnlyMode");
    expect(chatSource).not.toContain('testID="open-voice-mode-button"');
    expect(chatSource).not.toContain('testID="chat-mic-button"');
    expect(chatSource).not.toContain("Hold the mic to talk");
    expect(chatSource).toContain('testID="chat-input"');
    expect(chatSource).toContain('testID="chat-send-button"');
    expect(chatSource).not.toContain("!voiceOnlyMode ? (");
    expect(chatSource).not.toContain("voiceOnlyInitialOpenRef");
    expect(chatSource).not.toContain("voiceOnlyMode &&");
    expect(chatSource).not.toContain("openVoiceSession();\n    }\n  }, [voiceOnlyMode");
    expect(transcriptSource).not.toContain("Hold the orb. Your speech and reply will appear here.");
  });

  it("uses resolved voice language params instead of hard-coded Tamil defaults", () => {
    expect(chatSource).toContain("/api/transcribe-and-analyze");
    expect(chatSource).toContain("resolveVoiceLanguageParams");
    expect(chatSource).toContain("voiceLanguage.replyLanguage");
    expect(chatSource).toContain("voiceLanguage.speechLanguage");
    expect(chatSource).not.toContain("reply_language=ta&speech_language=ta-IN");
  });

  it("preserves files and artifacts with signed download metadata", () => {
    const item = normalizeChatResponse(
      {
        item: {
          id: 7,
          intent: "assistant",
          category: "Other",
          raw_text: "நேத்து சொன்ன business notes open பண்ணு",
          details: "1 கோப்பு கிடைத்தது.",
        },
        meta: {
          files: [
            {
              id: 11,
              title: "business notes",
              format: "pdf",
              category: "Business",
              relative_path: "pdf/Business/2026-05-18/business_notes.pdf",
              download_url: "/download/token",
              download_id: "token",
            },
          ],
          artifacts: [
            {
              id: 12,
              title: "meeting points",
              format: "docx",
              category: "Work",
              relative_path: "docx/Work/2026-05-19/meeting_points.docx",
              download: { download_url: "/download/token-2", download_id: "token-2" },
            },
          ],
        },
      },
      "",
    );

    expect(item.files?.[0]).toMatchObject({
      id: 11,
      title: "business notes",
      format: "pdf",
      category: "Business",
      relative_path: "pdf/Business/2026-05-18/business_notes.pdf",
      download_url: "/download/token",
      download_id: "token",
    });
    expect(item.artifacts?.[0]).toMatchObject({
      id: 12,
      title: "meeting points",
      format: "docx",
      category: "Work",
      download_url: "/download/token-2",
      download_id: "token-2",
    });
  });

  it("exposes an open-file action and auto-opens retrieval files", () => {
    expect(chatSource).toContain('testID="chat-open-file-button"');
    expect(chatSource).toContain("openReturnedFile(firstOpenableFile(nextItem, \"files\"))");
  });
});
