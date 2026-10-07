import { parentPort, workerData } from "node:worker_threads";
import { generateInvoicePDF, type InvoicePDFData, type InvoiceTemplate } from "./invoice-pdf.js";

const { data, format, template } = workerData as {
  data: InvoicePDFData;
  format: "a5" | "a4" | "thermal";
  template?: InvoiceTemplate;
};

const doc = generateInvoicePDF(data, format, template ?? "classic");
const chunks: Buffer[] = [];
doc.on("data", (chunk: Buffer) => chunks.push(chunk));
doc.on("end", () => {
  parentPort?.postMessage(Buffer.concat(chunks));
});
doc.end();
