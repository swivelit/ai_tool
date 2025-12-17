import { apiPost } from "./api";

export type ParsedDatetime = {
  iso: string | null;
  human: string;
  confidence: number;
};

export async function parseDatetime(text: string, timezone: string): Promise<ParsedDatetime> {
  return apiPost<ParsedDatetime>("/parse-datetime", {
    text,
    timezone,
    now_iso: new Date().toISOString(),
  });
}
