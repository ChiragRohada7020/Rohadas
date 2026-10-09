/**
 * report-pdf-gst.ts — GSTR-1 and GSTR-3B working summary PDFs.
 *
 * These are internal working papers, clearly labelled as such — they are NOT
 * official government filings. They render the aggregates produced by
 * `gst-reports.ts` (the same data the on-screen GST tabs and CSV/JSON exports
 * use) so a CA or accountant can review the numbers before filing.
 */

import {
  PDF_COLORS,
  ReportTable,
  createReportDoc,
  finalizeReportDoc,
  drawSectionHeader,
  fmt,
  fmtDate,
  fmtNum,
  type ColumnDef,
  type ReportHeaderInfo,
} from "./report-pdf-base.js";

// ── GSTR-1 data (mirrors GSTR1Report from gst-reports.ts) ────────────────

export interface GSTR1PDFData {
  period: string;
  businessGstin: string;
  businessName: string;
  b2b: Array<{
    partyGstin: string;
    partyName: string;
    invoiceNumber: string;
    invoiceDate: string;
    invoiceType: string;
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
    totalInvoiceValue: number;
  }>;
  b2cLarge: Array<{
    invoiceNumber: string;
    invoiceDate: string;
    state: string;
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
  }>;
  b2cSmall: Array<{ taxRate: number; taxableValue: number; cgst: number; sgst: number; igst: number }>;
  hsn: Array<{
    hsn: string;
    description: string;
    quantity: number;
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
    totalValue: number;
  }>;
  creditNotes: Array<{
    invoiceNumber: string;
    invoiceDate: string;
    partyName: string;
    totalAmount: string;
    taxableAmount: string;
    taxAmount: string;
  }>;
  debitNotes: Array<{
    invoiceNumber: string;
    invoiceDate: string;
    partyName: string;
    totalAmount: string;
    taxableAmount: string;
    taxAmount: string;
  }>;
  totalTaxableValue: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  totalTax: number;
  totalInvoiceValue: number;
  invoiceCount: number;
}

// ── GSTR-3B data (mirrors GSTR3BReport from gst-reports.ts) ──────────────

export interface GSTR3BPDFData {
  period: string;
  businessGstin: string;
  businessName: string;
  outwardSupplies: {
    taxable: { taxableValue: number; igst: number; cgst: number; sgst: number };
    zeroRated: { taxableValue: number; igst: number; cgst: number; sgst: number };
    exempt: { taxableValue: number; igst: number; cgst: number; sgst: number };
  };
  rcmSupplies: { taxableValue: string; cgst: string; sgst: string; igst: string };
  interStateUnregistered: Array<{ state: string; taxableValue: number; igst: number }>;
  itc: { igst: number; cgst: number; sgst: number; total: number };
  taxPayable: { igst: number; cgst: number; sgst: number };
  netTax: { igst: number; cgst: number; sgst: number; total: number };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function workingPaperBanner(doc: any, margin: number, contentW: number, y: number): number {
  doc.rect(margin, y, contentW, 18).fill("#fff4e5");
  doc.fontSize(7.5).fillColor("#b45309").font("NotoSans-Bold")
    .text("Internal working paper — not a government filing", margin + 6, y + 5, { width: contentW - 12, align: "center", lineBreak: false });
  return y + 24;
}


export function generateGSTR1PDF(data: GSTR1PDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: "GSTR-1 Working Summary",
    period: data.period,
    meta: data.businessGstin ? [`GSTIN: ${data.businessGstin}`] : undefined,
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    landscape: true,
    title: "GSTR-1 Working Summary",
    subject: `GSTR-1 working summary for ${data.period}`,
  });
  let y = workingPaperBanner(doc, margin, contentW, startY);

  // 4A. B2B
  if (data.b2b.length > 0) {
    y = drawSectionHeader(doc, "4A. B2B — Supplies to registered persons", margin, y, contentW);
    if (y + 18 > doc.page.height - 90) { doc.addPage(); y = margin; }
    const cols: ColumnDef[] = [
      { label: "GSTIN", width: 110, render: (r) => (r.partyGstin as string) || "—" },
      { label: "Party", width: 150, render: (r) => (r.partyName as string) || "—" },
      { label: "Invoice #", width: 95, render: (r) => (r.invoiceNumber as string) || "—" },
      { label: "Taxable", width: 100, align: "right", render: (r) => fmt(r.taxableValue as number) },
      { label: "CGST", width: 80, align: "right", render: (r) => fmt(r.cgst as number) },
      { label: "SGST", width: 80, align: "right", render: (r) => fmt(r.sgst as number) },
      { label: "IGST", width: 80, align: "right", render: (r) => fmt(r.igst as number) },
      { label: "Total", width: 100, align: "right", render: (r) => fmt(r.totalInvoiceValue as number), bold: true },
    ];
    const table = new ReportTable(doc, cols, { margin, contentW, rowH: 18 });
    y = table.drawHeader(y);
    y = table.render(data.b2b as unknown as Array<Record<string, unknown>>, y);
    y += 6;
  }

  // 5A. B2C Large
  if (data.b2cLarge.length > 0) {
    y = drawSectionHeader(doc, "5A. B2C (Large) — Unregistered, inter-state > ₹2.5L", margin, y, contentW);
    if (y + 18 > doc.page.height - 90) { doc.addPage(); y = margin; }
    const cols: ColumnDef[] = [
      { label: "Invoice #", width: 100, render: (r) => (r.invoiceNumber as string) || "—" },
      { label: "Date", width: 80, render: (r) => fmtDate(r.invoiceDate as string) },
      { label: "State", width: 120, render: (r) => (r.state as string) || "—" },
      { label: "Taxable", width: 120, align: "right", render: (r) => fmt(r.taxableValue as number) },
      { label: "CGST", width: 90, align: "right", render: (r) => fmt(r.cgst as number) },
      { label: "SGST", width: 90, align: "right", render: (r) => fmt(r.sgst as number) },
      { label: "IGST", width: 90, align: "right", render: (r) => fmt(r.igst as number) },
    ];
    const table = new ReportTable(doc, cols, { margin, contentW, rowH: 18 });
    y = table.drawHeader(y);
    y = table.render(data.b2cLarge as unknown as Array<Record<string, unknown>>, y);
    y += 6;
  }

  // 7. B2C Small
  if (data.b2cSmall.length > 0) {
    y = drawSectionHeader(doc, "7. B2C (Small) — Unregistered, rate-wise", margin, y, contentW);
    if (y + 18 > doc.page.height - 90) { doc.addPage(); y = margin; }
    const cols: ColumnDef[] = [
      { label: "Rate", width: 80, render: (r) => `${r.taxRate as number}%` },
      { label: "Taxable", width: 140, align: "right", render: (r) => fmt(r.taxableValue as number) },
      { label: "CGST", width: 120, align: "right", render: (r) => fmt(r.cgst as number) },
      { label: "SGST", width: 120, align: "right", render: (r) => fmt(r.sgst as number) },
      { label: "IGST", width: 120, align: "right", render: (r) => fmt(r.igst as number) },
    ];
    const table = new ReportTable(doc, cols, { margin, contentW, rowH: 18 });
    y = table.drawHeader(y);
    y = table.render(data.b2cSmall as unknown as Array<Record<string, unknown>>, y);
    y += 6;
  }

  // 12. HSN
  if (data.hsn.length > 0) {
    y = drawSectionHeader(doc, "12. HSN Summary", margin, y, contentW);
    if (y + 18 > doc.page.height - 90) { doc.addPage(); y = margin; }
    const cols: ColumnDef[] = [
      { label: "HSN", width: 80, render: (r) => (r.hsn as string) || "—" },
      { label: "Description", width: 200, render: (r) => (r.description as string) || "—" },
      { label: "Qty", width: 80, align: "right", render: (r) => fmtNum(r.quantity as number) },
      { label: "Taxable", width: 110, align: "right", render: (r) => fmt(r.taxableValue as number) },
      { label: "CGST", width: 80, align: "right", render: (r) => fmt(r.cgst as number) },
      { label: "SGST", width: 80, align: "right", render: (r) => fmt(r.sgst as number) },
      { label: "IGST", width: 80, align: "right", render: (r) => fmt(r.igst as number) },
    ];
    const table = new ReportTable(doc, cols, { margin, contentW, rowH: 18 });
    y = table.drawHeader(y);
    y = table.render(data.hsn as unknown as Array<Record<string, unknown>>, y);
    y += 6;
  }

  // Credit / debit notes
  const renderNotes = (label: string, notes: GSTR1PDFData["creditNotes"]): number => {
    if (notes.length === 0) return y;
    y = drawSectionHeader(doc, label, margin, y, contentW);
    if (y + 18 > doc.page.height - 90) { doc.addPage(); y = margin; }
    const cols: ColumnDef[] = [
      { label: "Note #", width: 110, render: (r) => (r.invoiceNumber as string) || "—" },
      { label: "Date", width: 90, render: (r) => fmtDate(r.invoiceDate as string) },
      { label: "Party", width: 220, render: (r) => (r.partyName as string) || "—" },
      { label: "Taxable", width: 120, align: "right", render: (r) => fmt(r.taxableAmount as string) },
      { label: "Tax", width: 110, align: "right", render: (r) => fmt(r.taxAmount as string) },
      { label: "Total", width: 120, align: "right", render: (r) => fmt(r.totalAmount as string), bold: true },
    ];
    const table = new ReportTable(doc, cols, { margin, contentW, rowH: 18 });
    y = table.drawHeader(y);
    y = table.render(notes as unknown as Array<Record<string, unknown>>, y);
    y += 6;
    return y;
  };
  y = renderNotes("Credit Notes (9B)", data.creditNotes);
  y = renderNotes("Debit Notes (9B)", data.debitNotes);

  // Totals
  if (y + 80 > doc.page.height - 80) { doc.addPage(); y = margin; }
  y = drawSectionHeader(doc, "Summary", margin, y, contentW);
  const totals: Array<[string, string]> = [
    ["Total Taxable Value", fmt(data.totalTaxableValue)],
    ["CGST", fmt(data.totalCgst)],
    ["SGST", fmt(data.totalSgst)],
    ["IGST", fmt(data.totalIgst)],
    ["Total Tax", fmt(data.totalTax)],
    ["Total Invoice Value", fmt(data.totalInvoiceValue)],
    ["Invoice Count", fmtNum(data.invoiceCount)],
  ];
  totals.forEach(([label, value]) => {
    if (y + 16 > doc.page.height - 70) { doc.addPage(); y = margin; }
    doc.fontSize(8).fillColor(PDF_COLORS.secondary).font("NotoSans")
      .text(label, margin + 4, y + 3, { width: 300, lineBreak: false });
    doc.fillColor(PDF_COLORS.primary).font("NotoSans-Bold")
      .text(value, margin + 304, y + 3, { width: contentW - 304, align: "right", lineBreak: false });
    y += 16;
  });

  return finalizeReportDoc(doc, margin, contentW);
}


export function generateGSTR3BPDF(data: GSTR3BPDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: "GSTR-3B Working Summary",
    period: data.period,
    meta: data.businessGstin ? [`GSTIN: ${data.businessGstin}`] : undefined,
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    title: "GSTR-3B Working Summary",
    subject: `GSTR-3B working summary for ${data.period}`,
  });
  let y = workingPaperBanner(doc, margin, contentW, startY);

  const colNameW = contentW - 320;
  const colW = 80;

  function taxRow(label: string, v: { igst: number; cgst: number; sgst: number }, total?: number): number {
    if (y + 17 > doc.page.height - 70) { doc.addPage(); y = margin; }
    doc.fontSize(7.5).fillColor(PDF_COLORS.primary).font("NotoSans")
      .text(label, margin + 4, y + 4, { width: colNameW - 8, lineBreak: false });
    let x = margin + colNameW;
    doc.text(fmt(v.igst), x + 4, y + 4, { width: colW - 8, align: "right", lineBreak: false });
    x += colW;
    doc.text(fmt(v.cgst), x + 4, y + 4, { width: colW - 8, align: "right", lineBreak: false });
    x += colW;
    doc.text(fmt(v.sgst), x + 4, y + 4, { width: colW - 8, align: "right", lineBreak: false });
    x += colW;
    doc.font("NotoSans-Bold")
      .text(fmt(total ?? (v.igst + v.cgst + v.sgst)), x + 4, y + 4, { width: colW - 8, align: "right", lineBreak: false });
    y += 17;
    return y;
  }

  // 3.1 Outward supplies
  y = drawSectionHeader(doc, "3.1 Outward Supplies", margin, y, contentW);
  doc.rect(margin, y, contentW, 18).fill(PDF_COLORS.primary);
  doc.fontSize(7.5).fillColor("#ffffff").font("NotoSans-Bold");
  doc.text("Description", margin + 4, y + 5, { width: colNameW - 8, lineBreak: false });
  let hx = margin + colNameW;
  doc.text("IGST", hx + 4, y + 5, { width: colW - 8, align: "right", lineBreak: false });
  hx += colW;
  doc.text("CGST", hx + 4, y + 5, { width: colW - 8, align: "right", lineBreak: false });
  hx += colW;
  doc.text("SGST", hx + 4, y + 5, { width: colW - 8, align: "right", lineBreak: false });
  hx += colW;
  doc.text("Total", hx + 4, y + 5, { width: colW - 8, align: "right", lineBreak: false });
  y += 18;

  y = taxRow("Taxable (3.1a)", data.outwardSupplies.taxable);
  y = taxRow("Zero Rated (3.1b)", data.outwardSupplies.zeroRated);
  y = taxRow("Exempt/Nil (3.1c)", data.outwardSupplies.exempt);

  // RCM
  y = drawSectionHeader(doc, "3.1(d) Inward Supplies liable to Reverse Charge", margin, y, contentW);
  y = taxRow("RCM", {
    igst: parseFloat(data.rcmSupplies.igst),
    cgst: parseFloat(data.rcmSupplies.cgst),
    sgst: parseFloat(data.rcmSupplies.sgst),
  });

  // ITC
  y = drawSectionHeader(doc, "4. Eligible Input Tax Credit", margin, y, contentW);
  y = taxRow("ITC", { igst: data.itc.igst, cgst: data.itc.cgst, sgst: data.itc.sgst }, data.itc.total);

  // Tax payable
  y = drawSectionHeader(doc, "5. Tax Payable", margin, y, contentW);
  y = taxRow("Tax Payable", { igst: data.taxPayable.igst, cgst: data.taxPayable.cgst, sgst: data.taxPayable.sgst });

  // Net tax
  y = drawSectionHeader(doc, "6. Net Tax (after ITC)", margin, y, contentW);
  y = taxRow("Net Tax", { igst: data.netTax.igst, cgst: data.netTax.cgst, sgst: data.netTax.sgst }, data.netTax.total);

  // Inter-state unregistered (3.2)
  if (data.interStateUnregistered.length > 0) {
    y = drawSectionHeader(doc, "3.2 Inter-state Supplies to Unregistered", margin, y, contentW);
    if (y + 18 > doc.page.height - 90) { doc.addPage(); y = margin; }
    const cols: ColumnDef[] = [
      { label: "State", width: contentW - 240, render: (r) => (r.state as string) || "—" },
      { label: "Taxable", width: 120, align: "right", render: (r) => fmt(r.taxableValue as number) },
      { label: "IGST", width: 120, align: "right", render: (r) => fmt(r.igst as number) },
    ];
    const table = new ReportTable(doc, cols, { margin, contentW, rowH: 18 });
    y = table.drawHeader(y);
    y = table.render(data.interStateUnregistered as unknown as Array<Record<string, unknown>>, y);
  }

  return finalizeReportDoc(doc, margin, contentW);
}
