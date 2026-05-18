export type GeneratedFileMetadata = {
  id?: number | string | null;
  item_id?: number | string | null;
  title?: string | null;
  format?: string | null;
  category?: string | null;
  relative_path?: string | null;
  source_text?: string | null;
  created_at?: string | null;
  download_url?: string | null;
  download_id?: string | null;
  download?: {
    download_url?: string | null;
    download_id?: string | null;
  } | null;
};

export type Item = {
  id: number;
  intent: string;
  category: string;
  raw_text: string;
  transcript?: string | null;
  datetime?: string | null;
  title?: string | null;
  details?: string | null;
  files?: GeneratedFileMetadata[];
  artifacts?: GeneratedFileMetadata[];
  meta?: Record<string, any> | null;
};
