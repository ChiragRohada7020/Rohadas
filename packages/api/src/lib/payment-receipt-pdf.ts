import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONT_REGULAR = resolve(__dirname, "../../fonts/NotoSans-Regular.ttf");
const FONT_BOLD = resolve(__dirname, "../../fonts/NotoSans-Bold.ttf");

// ── Types ──────────────────────────────────────────────────────

export interface ReceiptAllocation {
  invoiceNumber: string;
  invoiceDate: Date | string;
  totalAmount: string;
  allocatedAmount: string;
  status?: string | null;
  /** "sale" or "purchase" — decides receipt vs voucher on the printed document. */
  invoiceType?: string | null;
}

export interface PaymentReceiptPDFData {
  // Business
  businessName: string;
  businessGstin?: string | null;
  businessAddress?: string | null;
  businessCity?: string | null;
  businessPhone?: string | null;

  // Party
  partyName: string;
  partyPhone?: string | null;
  partyGstin?: string | null;

  // Payment
  paymentNumber: string;
  paymentDate: Date | string;
  amount: string;
  discount: string;
  mode: string;
  referenceNumber?: string | null;
  notes?: string | null;

  // Allocated invoices
  allocatedInvoices: ReceiptAllocation[];

  /** "receipt" for money received from a customer, "voucher" for money paid to a supplier. */
  direction: "receipt" | "voucher";
}

// ── Helpers ────────────────────────────────────────────────────

function fmt(amount: string | number | null | undefined): string {
  const num = typeof amount === "string" ? parseFloat(amount) : (amount ?? 0);
  if (!Number.isFinite(num)) return "0.00";
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

/** Rupees in words — printed on receipts so the amount cannot be altered silently. */
function amountInWords(amount: string): string {
  const num = Math.floor(parseFloat(amount) || 0);
  if (num === 0) return "Zero Rupees Only";
  if (num > 999999999) return ""; // beyond 100 crore — unusual on a receipt

  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
    "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function twoDigits(n: number): string {
    if (n < 20) return ones[n];
    return `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ""}`;
  }

  function threeDigits(n: number): string {
    const h = Math.floor(n / 100);
    const rest = n % 100;
    const parts: string[] = [];
    if (h) parts.push(`${ones[h]} Hundred`);
    if (rest) parts.push(twoDigits(rest));
    return parts.join(" ");
  }

  const crore = Math.floor(num / 10000000);
  const lakh = Math.floor((num % 10000000) / 100000);
  const thousand = Math.floor((num % 100000) / 1000);
  const hundred = num % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${threeDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigits(thousand)} Thousand`);
  if (hundred) parts.push(threeDigits(hundred));

  return `${parts.join(" ")} Rupees Only`;
}

// ── PDF Generator ─────────────────────────────────────────────

function generateReceiptPDFDoc(doc: InstanceType<typeof PDFDocument>, data: PaymentReceiptPDFData) {
  const pageW = 595.28; // A4
  const margin = 40;
  const contentW = pageW - margin * 2;
  let y = margin;

  const colorPrimary = "#1a1a2e";
  const colorSecondary = "#495057";
  const colorMuted = "#868e96";
  const colorAccent = "#4263eb";
  const colorBorder = "#dee2e6";
  const colorBg = "#f8f9fa";
  const colorCredit = "#2f9e44";

  const isReceipt = data.direction === "receipt";
  const docLabel = isReceipt ? "PAYMENT RECEIPT" : "PAYMENT VOUCHER";

  // ── Header ───────────────────────────────────────────────────

  doc.fontSize(16).fillColor(colorPrimary).font("NotoSans-Bold")
    .text(data.businessName, margin, y, { width: contentW });
  y += 21;

  const bizLine = [
    data.businessAddress,
    data.businessCity,
    data.businessPhone ? `Ph: ${data.businessPhone}` : null,
  ].filter(Boolean).join(" · ");
  if (bizLine) {
    doc.fontSize(8).fillColor(colorSecondary).font("NotoSans")
      .text(bizLine, margin, y, { width: contentW });
    y += 11;
  }
  if (data.businessGstin) {
    doc.fontSize(8).fillColor(colorSecondary).font("NotoSans")
      .text(`GSTIN: ${data.businessGstin}`, margin, y, { width: contentW });
    y += 11;
  }
  y += 4;

  // Title band
  const bandH = 24;
  doc.rect(margin, y, contentW, bandH).fill(colorAccent);
  doc.fontSize(11).fillColor("#ffffff").font("NotoSans-Bold")
    .text(docLabel, margin + 8, y + 7, { width: contentW / 2 });
  doc.fontSize(9).fillColor("#ffffff").font("NotoSans")
    .text(data.paymentNumber, margin + contentW / 2, y + 8,
      { width: contentW / 2 - 8, align: "right" });
  y += bandH + 14;

  // ── Party + payment detail blocks ────────────────────────────

  const halfW = (contentW - 12) / 2;

  doc.fontSize(7).fillColor(colorMuted).font("NotoSans")
    .text(isReceipt ? "RECEIVED FROM" : "PAID TO", margin, y, { width: halfW });
  doc.fontSize(10).fillColor(colorPrimary).font("NotoSans-Bold")
    .text(data.partyName, margin, y + 11, { width: halfW });
  let leftY = y + 25;
  if (data.partyGstin) {
    doc.fontSize(8).fillColor(colorSecondary).font("NotoSans")
      .text(`GSTIN: ${data.partyGstin}`, margin, leftY, { width: halfW });
    leftY += 11;
  }
  if (data.partyPhone) {
    doc.fontSize(8).fillColor(colorSecondary).font("NotoSans")
      .text(`Ph: ${data.partyPhone}`, margin, leftY, { width: halfW });
    leftY += 11;
  }

  const rx = margin + halfW + 12;
  const metaRows: Array<[string, string]> = [
    ["Date", fmtDate(data.paymentDate)],
    ["Mode", data.mode.charAt(0).toUpperCase() + data.mode.slice(1)],
  ];
  if (data.referenceNumber) metaRows.push(["Reference", data.referenceNumber]);

  let rightY = y;
  for (const [label, value] of metaRows) {
    doc.fontSize(7.5).fillColor(colorMuted).font("NotoSans")
      .text(label, rx, rightY, { width: 60 });
    doc.fontSize(8).fillColor(colorPrimary).font("NotoSans-Bold")
      .text(value, rx + 62, rightY, { width: halfW - 62 });
    rightY += 12;
  }

  y = Math.max(leftY, rightY) + 10;

  doc.strokeColor(colorBorder).lineWidth(0.75)
    .moveTo(margin, y).lineTo(margin + contentW, y).stroke();
  y += 14;

  // ── Amount panel ─────────────────────────────────────────────

  const amtBoxH = 46;
  doc.rect(margin, y, contentW, amtBoxH).fill(colorBg);
  doc.fontSize(7).fillColor(colorMuted).font("NotoSans")
    .text(isReceipt ? "AMOUNT RECEIVED" : "AMOUNT PAID", margin + 10, y + 7);
  doc.fontSize(15).fillColor(colorCredit).font("NotoSans-Bold")
    .text(`Rs. ${fmt(data.amount)}`, margin + 10, y + 18, { width: contentW / 2 });

  const words = amountInWords(data.amount);
  if (words) {
    doc.fontSize(7).fillColor(colorMuted).font("NotoSans")
      .text("IN WORDS", margin + contentW / 2, y + 7, { width: contentW / 2 - 10 });
    doc.fontSize(8).fillColor(colorSecondary).font("NotoSans")
      .text(words, margin + contentW / 2, y + 18, { width: contentW / 2 - 10 });
  }
  y += amtBoxH + 8;

  if (parseFloat(data.discount) > 0) {
    doc.fontSize(8).fillColor(colorSecondary).font("NotoSans")
      .text(`Discount allowed: Rs. ${fmt(data.discount)}`, margin, y, { width: contentW });
    y += 14;
  }

  y += 6;

  // ── Allocated invoices table ─────────────────────────────────

  if (data.allocatedInvoices.length > 0) {
    doc.fontSize(8.5).fillColor(colorPrimary).font("NotoSans-Bold")
      .text("Applied to invoices", margin, y, { width: contentW });
    y += 14;

    const col = {
      inv:   { x: margin,       w: 110 },
      date:  { x: margin + 110, w: 90 },
      total: { x: margin + 200, w: 110 },
      alloc: { x: margin + 310, w: contentW - 310 },
    };

    const hdrH = 18;
    doc.rect(margin, y, contentW, hdrH).fill(colorPrimary);
    doc.fontSize(7.5).fillColor("#ffffff").font("NotoSans-Bold");
    doc.text("INVOICE #",     col.inv.x + 4,   y + 5, { width: col.inv.w - 4 });
    doc.text("DATE",          col.date.x + 4,  y + 5, { width: col.date.w - 4 });
    doc.text("INVOICE TOTAL", col.total.x + 4, y + 5, { width: col.total.w - 4, align: "right" });
    doc.text("APPLIED",       col.alloc.x + 4, y + 5, { width: col.alloc.w - 4, align: "right" });
    y += hdrH;

    const rowH = 17;
    let totalAllocated = 0;
    data.allocatedInvoices.forEach((inv, i) => {
      if (y > doc.page.height - 90) {
        doc.addPage();
        y = margin;
      }
      doc.rect(margin, y, contentW, rowH).fill(i % 2 === 0 ? "#ffffff" : colorBg);
      doc.fontSize(8).fillColor(colorPrimary).font("NotoSans");
      doc.text(inv.invoiceNumber || "—", col.inv.x + 4, y + 5, { width: col.inv.w - 4 });
      doc.fillColor(colorSecondary)
        .text(fmtDate(inv.invoiceDate), col.date.x + 4, y + 5, { width: col.date.w - 4 });
      doc.fillColor(colorSecondary)
        .text(fmt(inv.totalAmount), col.total.x + 4, y + 5, { width: col.total.w - 4, align: "right" });
      doc.fillColor(colorPrimary).font("NotoSans-Bold")
        .text(fmt(inv.allocatedAmount), col.alloc.x + 4, y + 5, { width: col.alloc.w - 4, align: "right" });
      totalAllocated += parseFloat(inv.allocatedAmount) || 0;
      y += rowH;
    });

    doc.rect(margin, y, contentW, 19).fill(colorPrimary);
    doc.fontSize(8).fillColor("#ffffff").font("NotoSans-Bold");
    doc.text("Total applied", col.total.x + 4, y + 6, { width: col.total.w + 110, align: "right" });
    doc.text(fmt(totalAllocated), col.alloc.x + 4, y + 6, { width: col.alloc.w - 4, align: "right" });
    y += 19 + 12;
  }

  // ── Notes ────────────────────────────────────────────────────

  if (data.notes) {
    if (y > doc.page.height - 100) { doc.addPage(); y = margin; }
    doc.fontSize(7).fillColor(colorMuted).font("NotoSans")
      .text("NOTES", margin, y, { width: contentW });
    doc.fontSize(8).fillColor(colorSecondary).font("NotoSans")
      .text(data.notes, margin, y + 11, { width: contentW });
    y += 11 + doc.heightOfString(data.notes, { width: contentW }) + 10;
  }

  // ── Signature line ───────────────────────────────────────────

  if (y > doc.page.height - 80) { doc.addPage(); y = margin; }
  y += 14;
  doc.strokeColor(colorBorder).lineWidth(0.75)
    .moveTo(margin + contentW - 160, y).lineTo(margin + contentW, y).stroke();
  doc.fontSize(7.5).fillColor(colorMuted).font("NotoSans")
    .text(`For ${data.businessName}`, margin + contentW - 160, y + 4,
      { width: 160, align: "right" });
  y += 26;

  // ── Footer ───────────────────────────────────────────────────

  doc.fontSize(7).fillColor(colorMuted).font("NotoSans")
    .text(
      `Generated by Hisaabo on ${fmtDate(new Date())}`,
      margin, y,
      { width: contentW, align: "right" },
    );
}

// ── Public export — returns a Buffer ─────────────────────────

export function generatePaymentReceiptPDF(data: PaymentReceiptPDFData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      bufferPages: true,
      info: {
        Title: `${data.direction === "receipt" ? "Payment Receipt" : "Payment Voucher"} — ${data.paymentNumber}`,
        Author: data.businessName,
        Subject: `Payment ${data.paymentNumber} for ${data.partyName}`,
        Creator: "Hisaabo",
      },
    });

    doc.registerFont("NotoSans", FONT_REGULAR);
    doc.registerFont("NotoSans-Bold", FONT_BOLD);

    generateReceiptPDFDoc(doc, data);

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
