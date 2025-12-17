import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system";
import * as XLSX from "xlsx";
import { Item } from "./types";

export async function createPdfFromItem(item: Item) {
  const html = `
  <html>
    <body style="font-family: Arial; padding: 24px;">
      <h1>${escape(item.title || `Item ${item.id}`)}</h1>
      <p><b>Intent:</b> ${escape(item.intent)}</p>
      <p><b>Category:</b> ${escape(item.category)}</p>
      ${item.datetime ? `<p><b>When:</b> ${escape(item.datetime)}</p>` : ""}
      <hr/>
      <p>${escape(item.details || item.raw_text).replace(/\n/g, "<br/>")}</p>
    </body>
  </html>`;

  const { uri } = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri);
  }
  return uri;
}

export async function createExcelFromItem(item: Item) {
  const wsData = [
    ["Title", item.title || ""],
    ["Intent", item.intent],
    ["Category", item.category],
    ["When", item.datetime || ""],
    ["Details", item.details || item.raw_text],
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Item");

  const b64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" });
  const filename = `item_${item.id}.xlsx`;
  const path = FileSystem.documentDirectory + filename;

  await FileSystem.writeAsStringAsync(path, b64, { encoding: FileSystem.EncodingType.Base64 });

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(path);
  }
  return path;
}

function escape(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[c] as string));
}
