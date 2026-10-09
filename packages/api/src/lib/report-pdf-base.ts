/**
 * report-pdf-base.ts — shared primitives for the report PDF renderers.
 *
 * WHY THIS FILE EXISTS:
 * Trial balance, P&L, balance sheet, daybook, registers, outstanding, stock
 * summary and the GST working summaries all need the same building blocks:
 * an A4 document with a business header, a generic paginated table that
 * repeats its header row across page breaks, INR formatting and a generated-on
 * footer. Keeping those in one place stops the 12+ renderers from drifting
 * apart on fonts, colors and number formatting.
 */

import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

export type PDFDoc = InstanceType<typeof PDFDocument>;

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FONT_REGULAR = resolve(__dirname, "../../fonts/NotoSans-Regular.ttf");
export const FONT_BOLD = resolve(__dirname, "../../fonts/NotoSans-Bold.ttf");

// ── Palette — identical to the invoice/ledger/receipt PDFs ──────────────
export const PDF_COLORS = {
  primary: "#1a1a2e",
  secondary: "#495057",
  muted: "#868e96",
  accent: "#4263eb",
  border: "#dee2e6",
  bg: "#f8f9fa",
  debit: "#c92a2a",
  credit: "#2f9e44",
} as const;

export const A4 = { width: 595.28, height: 841.89 } as const;
export const A4_LANDSCAPE = { width: 841.89, height: 595.28 } as const;

// ── Formatting helpers ──────────────────────────────────────────────────

/** Indian-grouped currency (1,23,456.78). */
export function fmt(amount: string | number | null | undefined): string {
  const num = typeof amount === "string" ? parseFloat(amount) : (amount ?? 0);
  if (!Number.isFinite(num)) return "0.00";
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

/** Indian-grouped plain number (no decimals) — quantities, counts. */
export function fmtNum(n: string | number | null | undefined): string {
  const num = typeof n === "string" ? parseFloat(n) : (n ?? 0);
  if (!Number.isFinite(num)) return "0";
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 2,
  }).format(num);
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

// ── Column definition ───────────────────────────────────────────────────

export interface ColumnDef {
  label: string;
  width: number;
  align?: "left" | "right" | "center";
  /** Render function returning already-formatted text. */
  render: (row: Record<string, unknown>, index: number) => string;
  /** Optional fill color override for a row (e.g. red for debits). */
  color?: (row: Record<string, unknown>) => string;
  bold?: boolean;
}

/**
 * Paginated table renderer.
 *
 * Draws a column header band, then rows, repeating the header whenever the
 * cursor approaches the page bottom. Rows are passed as plain objects and
 * each column's `render` callback turns them into display strings.
 */
export class ReportTable {
  constructor(
    private doc: PDFDoc,
    private columns: ColumnDef[],
    private opts: { margin: number; contentW: number; rowH?: number; headerH?: number; zebra?: boolean } = {
      margin: 40,
      contentW: 515.28,
    },
  ) {}

  get rowH(): number {
    return this.opts.rowH ?? 18;
  }

  /** Total width of all columns — used to validate the table fits the page. */
  get totalWidth(): number {
    return this.columns.reduce((acc, c) => acc + c.width, 0);
  }

  /**
   * Draw the header band at the current cursor position. Returns the y
   * position immediately after the band.
   */
  drawHeader(y: number): number {
    const { doc, columns, opts } = this;
    const headerH = opts.headerH ?? 18;
    doc.rect(opts.margin, y, opts.contentW, headerH).fill(PDF_COLORS.primary);
    let x = opts.margin;
    doc.fontSize(7.5).fillColor("#ffffff").font("NotoSans-Bold");
    for (const col of columns) {
      doc.text(col.label, x + 4, y + (headerH - 9) / 2, {
        width: col.width - 8,
        align: col.align ?? "left",
        lineBreak: false,
      });
      x += col.width;
    }
    return y + headerH;
  }

  /**
   * Render all rows starting at `y`, returning the y position after the last
   * row. Handles page breaks and repeats the header.
   */
  render(rows: Array<Record<string, unknown>>, y: number): number {
    const { doc, columns, opts } = this;
    const rowH = this.rowH;
    const zebra = opts.zebra ?? true;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (y + rowH > doc.page.height - 70) {
        doc.addPage();
        y = opts.margin;
        y = this.drawHeader(y);
      }
      if (zebra && i % 2 === 1) {
        doc.rect(opts.margin, y, opts.contentW, rowH).fill(PDF_COLORS.bg);
      }
      let x = opts.margin;
      for (const col of columns) {
        const text = col.render(row, i);
        const color = col.color ? col.color(row) : PDF_COLORS.primary;
        doc.fontSize(7.5).fillColor(color);
        doc.font(col.bold ? "NotoSans-Bold" : "NotoSans");
        doc.text(text, x + 4, y + (rowH - 9) / 2, {
          width: col.width - 8,
          align: col.align ?? "left",
          lineBreak: false,
        });
        x += col.width;
      }
      y += rowH;
    }
    return y;
  }
}

// ── Report document factory ─────────────────────────────────────────────

export interface ReportHeaderInfo {
  businessName: string;
  title: string;
  subtitle?: string;
  /** e.g. "01 Apr 2025 to 30 Jun 2025" */
  period?: string;
  /** Right-aligned metadata lines, e.g. GSTIN, generated-at. */
  meta?: string[];
}

export interface ReportDocOptions {
  landscape?: boolean;
  title: string;
  subject: string;
}

/**
 * Create a PDFDocument configured for a report (fonts, metadata), draw the
 * standard business header, and return everything the renderer needs to keep
 * laying out content.
 */
export function createReportDoc(
  data: ReportHeaderInfo,
  opts: ReportDocOptions,
): {
  doc: PDFDoc;
  margin: number;
  contentW: number;
  pageW: number;
  y: number;
} {
  const page = opts.landscape ? A4_LANDSCAPE : A4;
  const doc = new PDFDocument({
    size: "A4",
    layout: opts.landscape ? "landscape" : "portrait",
    margin: 40,
    bufferPages: true,
    info: {
      Title: opts.title,
      Author: data.businessName,
      Subject: opts.subject,
      Creator: "Hisaabo",
    },
  });

  doc.registerFont("NotoSans", FONT_REGULAR);
  doc.registerFont("NotoSans-Bold", FONT_BOLD);

  const margin = 40;
  const contentW = page.width - margin * 2;
  let y = margin;

  // Business name
  doc.fontSize(15).fillColor(PDF_COLORS.primary).font("NotoSans-Bold")
    .text(data.businessName, margin, y, { width: contentW, lineBreak: false });
  y += 20;

  // Report title
  doc.fontSize(12).fillColor(PDF_COLORS.accent).font("NotoSans-Bold")
    .text(data.title, margin, y, { width: contentW, lineBreak: false });
  y += 15;

  // Period / subtitle
  if (data.period || data.subtitle) {
    doc.fontSize(8.5).fillColor(PDF_COLORS.secondary).font("NotoSans")
      .text(data.period ?? data.subtitle ?? "", margin, y, { width: contentW, lineBreak: false });
    y += 12;
  }

  // Meta lines (right-aligned)
  if (data.meta && data.meta.length > 0) {
    doc.fontSize(7.5).fillColor(PDF_COLORS.muted).font("NotoSans");
    for (const line of data.meta) {
      doc.text(line, margin, y, { width: contentW, align: "right", lineBreak: false });
      y += 10;
    }
  }

  y += 4;

  // Divider
  doc.strokeColor(PDF_COLORS.border).lineWidth(0.75)
    .moveTo(margin, y).lineTo(margin + contentW, y).stroke();
  y += 12;

  return { doc, margin, contentW, pageW: page.width, y };
}

/** Draw the standard generated-on footer at the bottom of the current page. */
export function drawReportFooter(doc: PDFDoc, margin: number, contentW: number): void {
  const y = doc.page.height - 32;
  doc.strokeColor(PDF_COLORS.border).lineWidth(0.5)
    .moveTo(margin, y).lineTo(margin + contentW, y).stroke();
  doc.fontSize(7).fillColor(PDF_COLORS.muted).font("NotoSans")
    .text(
      `Generated by Hisaabo on ${fmtDate(new Date())}`,
      margin,
      y + 4,
      { width: contentW, align: "right", lineBreak: false },
    );
}

/** Finish a report document: footer on every page, then resolve the buffer. */
export function finalizeReportDoc(doc: PDFDoc, margin: number, contentW: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      drawReportFooter(doc, margin, contentW);
    }
    doc.flushPages();

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

/** Convenience: a section heading with the standard accent styling. */
export function drawSectionHeader(
  doc: PDFDoc,
  text: string,
  x: number,
  y: number,
  contentW: number,
  opts: { dark?: boolean } = {},
): number {
  doc.fontSize(9.5).fillColor(opts.dark ? PDF_COLORS.primary : PDF_COLORS.accent)
    .font("NotoSans-Bold").text(text, x, y, { width: contentW, lineBreak: false });
  return y + 14;
}
