import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system";
import { Item } from "./types";

/**
 * Local PDF generation (works great on device)
 */
export async function createPdfFromItem(item: Item) {
  const html = `
  <html>
    <body style="font-family: Arial; padding: 24px;">
      <h1>${escapeHtml(item.title || `Item ${item.id}`)}</h1>
      <p><b>Intent:</b> ${escapeHtml(item.intent)}</p>
      <p><b>Category:</b> ${escapeHtml(item.category)}</p>
      ${item.datetime ? `<p><b>When:</b> ${escapeHtml(item.datetime)}</p>` : ""}
      <hr/>
      <p>${escapeHtml(item.details || item.raw_text).replace(/\n/g, "<br/>")}</p>
    </body>
  </html>`;

  const { uri } = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri);
  }
  return uri;
}

/**
 * Local "Excel" without xlsx:
 * Generate CSV which Excel/Google Sheets opens perfectly.
 * This avoids the SheetJS security advisory and bundling issues.
 */
export async function createCsvFromItem(item: Item) {
  const rows: Array<[string, string]> = [
    ["Title", item.title || ""],
    ["Intent", item.intent || ""],
    ["Category", item.category || ""],
    ["When", item.datetime || ""],
    ["Details", item.details || item.raw_text || ""],
  ];

  // CSV with proper quoting
  const csv = rows
    .map(([k, v]) => `${csvCell(k)},${csvCell(v)}`)
    .join("\n");

  const filename = `item_${item.id}.csv`;
  const path = FileSystem.documentDirectory + filename;

  // UTF-8 (optionally prepend BOM for Excel; helps on some devices/locales)
  const withBom = "\ufeff" + csv;
  await FileSystem.writeAsStringAsync(path, withBom, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(path, {
      mimeType: "text/csv",
      dialogTitle: "Share CSV",
      UTI: "public.comma-separated-values-text",
    });
  }
  return path;
}

function csvCell(value: string) {
  const s = String(value ?? "");
  // Escape quotes, wrap in quotes if needed
  const needsQuotes = /[",\n\r]/.test(s);
  const escaped = s.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

function escapeHtml(s: string) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return map[c] || c;
  });
}