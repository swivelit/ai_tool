export type VideoJob = {
  id: string; template_id: string; state: string; phase: string; progress: number;
  error: string; funding: string; thread_id: string | null; expires_at: string | null;
  queue_position: number | null; eta_seconds: [number, number] | null; paused: boolean;
  refund_status: string | null; notification_status?: string | null; options: { swap: string; enhance: string; caption: string };
}
export type VideoCapabilities = {
  enabled: boolean; paid_enabled: boolean; available: boolean; price_paise: number; policy_version: string;
  allowance: { unlimited: boolean; remaining: number | null; reset_at: string };
  templates: { id: string; title: string; available: boolean }[];
}
