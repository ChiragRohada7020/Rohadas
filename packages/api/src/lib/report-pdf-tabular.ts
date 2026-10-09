/**
 * report-pdf-tabular.ts — operational/transactional report renderers.
 *
 * Daybook, Sales/Purchase registers, Outstanding (receivables/payables ageing),
 * Stock Summary, General Ledger and Tax Summary. All of these render flat or
 * lightly-nested tabular data produced by the tRPC reports router.
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

// ── Daybook ─────────────────────────────────────────────────────────────

export interface DaybookEntry {
  time: Date | string;
  entryType: "invoice" | "payment" | "expense";
  number: string | null;
  partyOrCategory: string;
  debit: string;
  credit: string;
  mode: string | null;
  status: string | null;
}

export interface DaybookPDFData {
  businessName: string;
  fromDate: string;
  toDate: string;
  entries: DaybookEntry[];
  summary: {
    totalSalesInvoiced: string;
    totalPurchaseInvoiced: string;
    totalPaymentsReceived: string;
    totalPaymentsMade: string;
    totalExpenses: string;
    netCashMovement: string;
  };
}

const ENTRY_TYPE_LABEL: Record<string, string> = {
  invoice: "Invoice",
  payment: "Payment",
  expense: "Expense",
};

export function generateDaybookPDF(data: DaybookPDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: "Daybook",
    period: `${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    landscape: true,
    title: "Daybook",
    subject: `Daybook for ${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  });
  let y = startY;

  const cols: ColumnDef[] = [
    { label: "Date", width: 80, render: (r) => fmtDate(r.time as Date | string) },
    { label: "Type", width: 60, render: (r) => ENTRY_TYPE_LABEL[r.entryType as string] ?? "" },
    { label: "Number", width: 90, render: (r) => (r.number as string) || "—" },
    { label: "Party / Category", width: 190, render: (r) => (r.partyOrCategory as string) || "—" },
    { label: "Debit", width: 110, align: "right", render: (r) => fmt(r.debit as string), color: () => PDF_COLORS.debit },
    { label: "Credit", width: 110, align: "right", render: (r) => fmt(r.credit as string), color: () => PDF_COLORS.credit },
    { label: "Mode", width: 60, render: (r) => (r.mode as string) || "—" },
    { label: "Status", width: 62, render: (r) => (r.status as string) || "—" },
  ];

  const table = new ReportTable(doc, cols, { margin, contentW, rowH: 18 });
  y = table.drawHeader(y);
  y = table.render(data.entries as unknown as Array<Record<string, unknown>>, y);
  y += 8;

  // Summary band
  if (y + 96 > doc.page.height - 80) { doc.addPage(); y = margin; }
  y = drawSectionHeader(doc, "Summary", margin, y, contentW);
  const summaryRows: Array<[string, string]> = [
    ["Sales Invoiced", data.summary.totalSalesInvoiced],
    ["Purchases Invoiced", data.summary.totalPurchaseInvoiced],
    ["Payments Received", data.summary.totalPaymentsReceived],
    ["Payments Made", data.summary.totalPaymentsMade],
    ["Expenses", data.summary.totalExpenses],
  ];
  const halfW = contentW / 2;
  summaryRows.forEach(([label, value], i) => {
    const colX = margin + (i % 2) * halfW;
    const rowY = y + Math.floor(i / 2) * 18;
    doc.fontSize(8).fillColor(PDF_COLORS.secondary).font("NotoSans")
      .text(label, colX + 4, rowY + 4, { width: halfW / 2, lineBreak: false });
    doc.fillColor(PDF_COLORS.primary).font("NotoSans-Bold")
      .text(fmt(value), colX + halfW / 2, rowY + 4, { width: halfW / 2 - 4, align: "right", lineBreak: false });
  });
  y += 54;

  // Net cash movement
  const net = parseFloat(data.summary.netCashMovement);
  doc.rect(margin, y, contentW, 20).fill(net >= 0 ? "#e7f5ec" : "#fdecec");
  doc.fontSize(8.5).fillColor(net >= 0 ? PDF_COLORS.credit : PDF_COLORS.debit).font("NotoSans-Bold");
  doc.text("Net Cash Movement", margin + 6, y + 6, { width: contentW - 200, lineBreak: false });
  doc.text(fmt(data.summary.netCashMovement), margin + contentW - 200, y + 6, { width: 190, align: "right", lineBreak: false });

  return finalizeReportDoc(doc, margin, contentW);
}

// ── Sales / Purchase Register ───────────────────────────────────────────

export interface RegisterRow {
  invoiceDate: Date | string;
  invoiceNumber: string;
  partyName: string;
  partyGstin?: string | null;
  subtotal: string;
  discountAmount?: string | null;
  taxAmount: string;
  totalAmount: string;
  amountPaid: string;
  status: string;
}

export interface RegisterPDFData {
  businessName: string;
  title: string;
  fromDate: string;
  toDate: string;
  rows: RegisterRow[];
  summary: { totalSubtotal: string; totalTax: string; totalAmount: string; count: number };
}

export function generateRegisterPDF(data: RegisterPDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: data.title,
    period: `${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    landscape: true,
    title: data.title,
    subject: `${data.title} for ${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  });
  let y = startY;

  const cols: ColumnDef[] = [
    { label: "Date", width: 78, render: (r) => fmtDate(r.invoiceDate as Date | string) },
    { label: "Invoice #", width: 100, render: (r) => (r.invoiceNumber as string) || "—" },
    { label: "Party", width: 190, render: (r) => (r.partyName as string) || "—" },
    { label: "Taxable", width: 100, align: "right", render: (r) => fmt(r.subtotal as string) },
    { label: "Tax", width: 90, align: "right", render: (r) => fmt(r.taxAmount as string) },
    { label: "Total", width: 110, align: "right", render: (r) => fmt(r.totalAmount as string), bold: true },
    { label: "Paid", width: 100, align: "right", render: (r) => fmt(r.amountPaid as string) },
    { label: "Status", width: 64, render: (r) => (r.status as string) || "—" },
  ];

  const table = new ReportTable(doc, cols, { margin, contentW, rowH: 18 });
  y = table.drawHeader(y);
  y = table.render(data.rows as unknown as Array<Record<string, unknown>>, y);
  y += 8;

  if (y + 20 > doc.page.height - 80) { doc.addPage(); y = margin; }
  doc.rect(margin, y, contentW, 20).fill(PDF_COLORS.primary);
  doc.fontSize(8).fillColor("#ffffff").font("NotoSans-Bold");
  const labelX = margin + 78 + 100 + 190; // after date+invoice+party
  doc.text(`Total (${fmtNum(data.summary.count)} invoices)`, labelX + 4, y + 6, { width: 200, lineBreak: false });
  doc.text(fmt(data.summary.totalSubtotal), labelX + 200, y + 6, { width: 100, align: "right", lineBreak: false });
  doc.text(fmt(data.summary.totalTax), labelX + 300, y + 6, { width: 90, align: "right", lineBreak: false });
  doc.text(fmt(data.summary.totalAmount), labelX + 390, y + 6, { width: 110, align: "right", lineBreak: false });

  return finalizeReportDoc(doc, margin, contentW);
}

// ── Outstanding (Receivables / Payables ageing) ─────────────────────────

export interface OutstandingInvoice {
  invoiceNumber: string;
  invoiceDate: Date | string;
  dueDate: Date | string | null;
  totalAmount: string;
  amountPaid: string;
  outstanding: string;
  daysOverdue: string;
}

export interface OutstandingParty {
  partyName: string;
  partyPhone: string | null;
  current: string;
  days31_60: string;
  days61_90: string;
  days90Plus: string;
  total: string;
  invoices: OutstandingInvoice[];
}

export interface OutstandingBucket {
  parties: OutstandingParty[];
  summary: { current: string; days31_60: string; days61_90: string; days90Plus: string; total: string };
}

export interface OutstandingPDFData {
  businessName: string;
  asOfDate: string;
  title: string;
  receivables: OutstandingBucket | null;
  payables: OutstandingBucket | null;
}

const AGING_COLS: ColumnDef[] = [
  { label: "Party", width: 190, render: (r) => (r.partyName as string) || "—" },
  { label: "Current", width: 92, align: "right", render: (r) => fmt(r.current as string) },
  { label: "31–60 days", width: 92, align: "right", render: (r) => fmt(r.days31_60 as string) },
  { label: "61–90 days", width: 92, align: "right", render: (r) => fmt(r.days61_90 as string) },
  { label: "90+ days", width: 92, align: "right", render: (r) => fmt(r.days90Plus as string), color: () => PDF_COLORS.debit },
  { label: "Total", width: 110, align: "right", render: (r) => fmt(r.total as string), bold: true },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderBucket(doc: any, bucket: OutstandingBucket | null, label: string, margin: number, contentW: number, y: number): number {
  if (!bucket || bucket.parties.length === 0) return y;
  y = drawSectionHeader(doc, label, margin, y, contentW);
  if (y + 18 > doc.page.height - 90) { doc.addPage(); y = margin; }
  const table = new ReportTable(doc, AGING_COLS, { margin, contentW, rowH: 18 });
  y = table.drawHeader(y);
  y = table.render(bucket.parties as unknown as Array<Record<string, unknown>>, y);

  if (y + 20 > doc.page.height - 80) { doc.addPage(); y = margin; }
  doc.rect(margin, y, contentW, 20).fill(PDF_COLORS.primary);
  doc.fontSize(8).fillColor("#ffffff").font("NotoSans-Bold");
  doc.text(`Total ${label}`, margin + 4, y + 6, { width: 190, lineBreak: false });
  let x = margin + 190;
  doc.text(fmt(bucket.summary.current), x + 4, y + 6, { width: 92, align: "right", lineBreak: false });
  x += 92;
  doc.text(fmt(bucket.summary.days31_60), x + 4, y + 6, { width: 92, align: "right", lineBreak: false });
  x += 92;
  doc.text(fmt(bucket.summary.days61_90), x + 4, y + 6, { width: 92, align: "right", lineBreak: false });
  x += 92;
  doc.text(fmt(bucket.summary.days90Plus), x + 4, y + 6, { width: 92, align: "right", lineBreak: false });
  x += 92;
  doc.text(fmt(bucket.summary.total), x + 4, y + 6, { width: 110, align: "right", lineBreak: false });
  y += 20 + 10;
  return y;
}

export function generateOutstandingPDF(data: OutstandingPDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: data.title,
    period: `As of ${fmtDate(data.asOfDate)}`,
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    landscape: true,
    title: data.title,
    subject: `${data.title} as of ${fmtDate(data.asOfDate)}`,
  });
  let y = startY;
  y = renderBucket(doc, data.receivables, "Receivables (Customers)", margin, contentW, y);
  y += 4;
  y = renderBucket(doc, data.payables, "Payables (Suppliers)", margin, contentW, y);
  return finalizeReportDoc(doc, margin, contentW);
}

// ── Stock Summary ───────────────────────────────────────────────────────

export interface StockItem {
  itemName: string;
  category: string | null;
  hsn: string | null;
  unit: string | null;
  currentStock: string;
  stockValue: string;
  stockValueAtSale: string;
  isLowStock?: boolean;
}

export interface StockVariantItem {
  itemName: string;
  category: string | null;
  unit: string | null;
  totalStock: string;
  totalValue: string;
  totalValueAtSale: string;
}

export interface StockSummaryPDFData {
  businessName: string;
  asOfDate: string;
  simpleItems: StockItem[];
  variantItems: StockVariantItem[];
  summary: { totalCostValue: string; totalSaleValue: string; totalSkuCount: number; lowStockCount: number };
}

export function generateStockSummaryPDF(data: StockSummaryPDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: "Stock Summary",
    period: `As of ${fmtDate(data.asOfDate)}`,
    meta: [`SKUs: ${fmtNum(data.summary.totalSkuCount)}`, `Low stock: ${fmtNum(data.summary.lowStockCount)}`],
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    landscape: true,
    title: "Stock Summary",
    subject: `Stock Summary as of ${fmtDate(data.asOfDate)}`,
  });
  let y = startY;

  const cols: ColumnDef[] = [
    { label: "Item", width: 220, render: (r) => (r.itemName as string) || "—" },
    { label: "Category", width: 110, render: (r) => (r.category as string) || "—" },
    { label: "Unit", width: 60, render: (r) => (r.unit as string) || "—" },
    { label: "Qty", width: 90, align: "right", render: (r) => fmtNum(r.currentStock as string) },
    { label: "Cost Value", width: 120, align: "right", render: (r) => fmt(r.stockValue as string) },
    { label: "Sale Value", width: 120, align: "right", render: (r) => fmt(r.stockValueAtSale as string) },
  ];

  // Merge simple + variant into a single flat row stream for rendering.
  const rows = [
    ...data.simpleItems.map((it) => ({
      itemName: it.itemName,
      category: it.category,
      unit: it.unit,
      currentStock: it.currentStock,
      stockValue: it.stockValue,
      stockValueAtSale: it.stockValueAtSale,
    })),
    ...data.variantItems.map((it) => ({
      itemName: `${it.itemName} (variants)`,
      category: it.category,
      unit: it.unit,
      currentStock: it.totalStock,
      stockValue: it.totalValue,
      stockValueAtSale: it.totalValueAtSale,
    })),
  ];

  const table = new ReportTable(doc, cols, { margin, contentW, rowH: 18 });
  y = table.drawHeader(y);
  y = table.render(rows as unknown as Array<Record<string, unknown>>, y);
  y += 8;

  if (y + 20 > doc.page.height - 80) { doc.addPage(); y = margin; }
  doc.rect(margin, y, contentW, 20).fill(PDF_COLORS.primary);
  doc.fontSize(8).fillColor("#ffffff").font("NotoSans-Bold");
  doc.text("Total Inventory Value", margin + 4, y + 6, { width: 480, lineBreak: false });
  doc.text(fmt(data.summary.totalCostValue), margin + 480, y + 6, { width: 120, align: "right", lineBreak: false });
  doc.text(fmt(data.summary.totalSaleValue), margin + 600, y + 6, { width: 120, align: "right", lineBreak: false });

  return finalizeReportDoc(doc, margin, contentW);
}

// ── General Ledger ──────────────────────────────────────────────────────

export interface GeneralLedgerEntry {
  date: Date | string;
  narration: string;
  sourceNumber: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface GeneralLedgerPDFData {
  businessName: string;
  accountCode: string;
  accountName: string;
  fromDate: string;
  toDate: string;
  entries: GeneralLedgerEntry[];
  closingBalance: string;
}

export function generateGeneralLedgerPDF(data: GeneralLedgerPDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: `General Ledger — ${data.accountCode} ${data.accountName}`,
    period: `${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    title: `General Ledger — ${data.accountName}`,
    subject: `General ledger for ${data.accountCode} ${data.accountName}`,
  });
  let y = startY;

  const colDate = 70;
  const colSource = 90;
  const colDebit = 90;
  const colCredit = 90;
  const colBal = 95;
  const colNarrationW = contentW - (colDate + colSource + colDebit + colCredit + colBal);

  doc.rect(margin, y, contentW, 18).fill(PDF_COLORS.primary);
  doc.fontSize(7.5).fillColor("#ffffff").font("NotoSans-Bold");
  let x = margin;
  doc.text("Date", x + 4, y + 5, { width: colDate - 8, lineBreak: false });
  x += colDate;
  doc.text("Narration", x + 4, y + 5, { width: colNarrationW - 8, lineBreak: false });
  x += colNarrationW;
  doc.text("Ref", x + 4, y + 5, { width: colSource - 8, lineBreak: false });
  x += colSource;
  doc.text("Debit", x + 4, y + 5, { width: colDebit - 8, align: "right", lineBreak: false });
  x += colDebit;
  doc.text("Credit", x + 4, y + 5, { width: colCredit - 8, align: "right", lineBreak: false });
  x += colCredit;
  doc.text("Balance", x + 4, y + 5, { width: colBal - 8, align: "right", lineBreak: false });
  y += 18;

  data.entries.forEach((e, i) => {
    if (y + 17 > doc.page.height - 70) { doc.addPage(); y = margin; }
    if (i % 2 === 1) doc.rect(margin, y, contentW, 17).fill(PDF_COLORS.bg);
    const balNum = parseFloat(e.balance);
    const balColor = balNum > 0 ? PDF_COLORS.debit : balNum < 0 ? PDF_COLORS.credit : PDF_COLORS.primary;
    x = margin;
    doc.fontSize(7.5).fillColor(PDF_COLORS.secondary).font("NotoSans")
      .text(fmtDate(e.date), x + 4, y + 4.5, { width: colDate - 8, lineBreak: false });
    x += colDate;
    doc.fillColor(PDF_COLORS.primary)
      .text(e.narration || "—", x + 4, y + 4.5, { width: colNarrationW - 8, lineBreak: false });
    x += colNarrationW;
    doc.fillColor(PDF_COLORS.muted)
      .text(e.sourceNumber || "—", x + 4, y + 4.5, { width: colSource - 8, lineBreak: false });
    x += colSource;
    doc.fillColor(PDF_COLORS.debit)
      .text(fmt(e.debit), x + 4, y + 4.5, { width: colDebit - 8, align: "right", lineBreak: false });
    x += colDebit;
    doc.fillColor(PDF_COLORS.credit)
      .text(fmt(e.credit), x + 4, y + 4.5, { width: colCredit - 8, align: "right", lineBreak: false });
    x += colCredit;
    doc.font("NotoSans-Bold").fillColor(balColor)
      .text(fmt(e.balance), x + 4, y + 4.5, { width: colBal - 8, align: "right", lineBreak: false });
    y += 17;
  });

  if (y + 22 > doc.page.height - 80) { doc.addPage(); y = margin; }
  doc.rect(margin, y, contentW, 22).fill(PDF_COLORS.primary);
  doc.fontSize(8).fillColor("#ffffff").font("NotoSans-Bold");
  doc.text("Closing Balance", margin + 4, y + 7, { width: colDate + colNarrationW + colSource, lineBreak: false });
  doc.text(fmt(data.closingBalance), margin + colDate + colNarrationW + colSource + colDebit + colCredit, y + 7, { width: colBal - 4, align: "right", lineBreak: false });

  return finalizeReportDoc(doc, margin, contentW);
}

// ── Tax Summary ─────────────────────────────────────────────────────────

export interface TaxBreakdownRow {
  invoiceType?: string;
  taxPercent: string;
  invoiceCount?: number;
  taxableAmount: string;
  taxAmount: string;
  grossAmount?: string;
}

export interface TaxSummaryPDFData {
  businessName: string;
  fromDate: string;
  toDate: string;
  salesBreakdown: TaxBreakdownRow[];
  purchaseBreakdown: TaxBreakdownRow[];
  summary: { totalTaxCollected: string; totalTaxPaid: string; netTaxLiability: string };
}

export function generateTaxSummaryPDF(data: TaxSummaryPDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: "Tax Summary (GST)",
    period: `${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    title: "Tax Summary (GST)",
    subject: `Tax summary for ${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  });
  let y = startY;

  const cols: ColumnDef[] = [
    { label: "Rate", width: 80, render: (r) => `${r.taxPercent as string}%` },
    { label: "Invoices", width: 90, align: "right", render: (r) => fmtNum(r.invoiceCount as number) },
    { label: "Taxable", width: 130, align: "right", render: (r) => fmt(r.taxableAmount as string) },
    { label: "Tax", width: 130, align: "right", render: (r) => fmt(r.taxAmount as string), bold: true },
  ];

  function renderSection(label: string, rows: TaxBreakdownRow[]): number {
    if (rows.length === 0) return y;
    y = drawSectionHeader(doc, label, margin, y, contentW);
    if (y + 18 > doc.page.height - 90) { doc.addPage(); y = margin; }
    const table = new ReportTable(doc, cols, { margin, contentW, rowH: 18 });
    y = table.drawHeader(y);
    y = table.render(rows as unknown as Array<Record<string, unknown>>, y);
    y += 4;
    return y;
  }

  y = renderSection("Sales (Output Tax)", data.salesBreakdown);
  y = renderSection("Purchases (Input Tax)", data.purchaseBreakdown);
  y += 4;

  const liability = parseFloat(data.summary.netTaxLiability);
  const rows: Array<[string, string, boolean]> = [
    ["Total Tax Collected (Output)", data.summary.totalTaxCollected, false],
    ["Total Tax Paid (Input)", data.summary.totalTaxPaid, false],
    ["Net Tax Liability", data.summary.netTaxLiability, true],
  ];
  rows.forEach(([label, value, dark]) => {
    if (y + 20 > doc.page.height - 80) { doc.addPage(); y = margin; }
    doc.rect(margin, y, contentW, 20).fill(dark ? (liability >= 0 ? "#e7f5ec" : "#fdecec") : PDF_COLORS.bg);
    doc.fontSize(8).fillColor(PDF_COLORS.primary).font(dark ? "NotoSans-Bold" : "NotoSans");
    doc.text(label, margin + 6, y + 6, { width: contentW - 200, lineBreak: false });
    doc.text(fmt(value), margin + contentW - 200, y + 6, { width: 190, align: "right", lineBreak: false });
    y += 20;
  });

  return finalizeReportDoc(doc, margin, contentW);
}

// ── Payment Summary ─────────────────────────────────────────────────────

export interface PaymentModeRow {
  mode: string;
  bankAccountName: string | null;
  count: number;
  totalAmount: string;
  customerPayments: string;
  supplierPayments: string;
}

export interface ExpenseModeRow {
  mode: string;
  count: number;
  totalAmount: string;
}

export interface RecentPaymentRow {
  paymentNumber: string | null;
  date: Date | string;
  partyName: string;
  partyType: string;
  amount: string;
  mode: string;
}

export interface PaymentSummaryPDFData {
  businessName: string;
  fromDate: string;
  toDate: string;
  byMode: PaymentModeRow[];
  expenses: ExpenseModeRow[];
  recentPayments: RecentPaymentRow[];
  totalReceived: string;
  totalMade: string;
  totalExpenses: string;
  netCashMovement: string;
}

export function generatePaymentSummaryPDF(data: PaymentSummaryPDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: "Payment Summary",
    period: `${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    landscape: true,
    title: "Payment Summary",
    subject: `Payment summary for ${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  });
  let y = startY;

  if (data.byMode.length > 0) {
    y = drawSectionHeader(doc, "Payments by Mode & Account", margin, y, contentW);
    if (y + 18 > doc.page.height - 90) { doc.addPage(); y = margin; }
    const cols: ColumnDef[] = [
      { label: "Mode", width: 110, render: (r) => (r.mode as string) || "—" },
      { label: "Account", width: 170, render: (r) => (r.bankAccountName as string) || "—" },
      { label: "Count", width: 70, align: "right", render: (r) => fmtNum(r.count as number) },
      { label: "Received", width: 115, align: "right", render: (r) => fmt(r.customerPayments as string), color: () => PDF_COLORS.credit },
      { label: "Paid", width: 115, align: "right", render: (r) => fmt(r.supplierPayments as string), color: () => PDF_COLORS.debit },
      { label: "Total", width: 115, align: "right", render: (r) => fmt(r.totalAmount as string), bold: true },
    ];
    const table = new ReportTable(doc, cols, { margin, contentW, rowH: 18 });
    y = table.drawHeader(y);
    y = table.render(data.byMode as unknown as Array<Record<string, unknown>>, y);
    y += 6;
  }

  if (data.expenses.length > 0) {
    y = drawSectionHeader(doc, "Expenses by Mode", margin, y, contentW);
    if (y + 18 > doc.page.height - 90) { doc.addPage(); y = margin; }
    const cols: ColumnDef[] = [
      { label: "Mode", width: 200, render: (r) => (r.mode as string) || "—" },
      { label: "Count", width: 130, align: "right", render: (r) => fmtNum(r.count as number) },
      { label: "Total", width: 160, align: "right", render: (r) => fmt(r.totalAmount as string), bold: true },
    ];
    const table = new ReportTable(doc, cols, { margin, contentW, rowH: 18 });
    y = table.drawHeader(y);
    y = table.render(data.expenses as unknown as Array<Record<string, unknown>>, y);
    y += 6;
  }

  if (data.recentPayments.length > 0) {
    y = drawSectionHeader(doc, `Recent Payments (${fmtNum(data.recentPayments.length)})`, margin, y, contentW);
    if (y + 18 > doc.page.height - 90) { doc.addPage(); y = margin; }
    const cols: ColumnDef[] = [
      { label: "Date", width: 90, render: (r) => fmtDate(r.date as Date | string) },
      { label: "Payment #", width: 105, render: (r) => (r.paymentNumber as string) || "—" },
      { label: "Party", width: 210, render: (r) => (r.partyName as string) || "—" },
      { label: "Type", width: 80, render: (r) => (r.partyType as string) || "—" },
      { label: "Mode", width: 90, render: (r) => (r.mode as string) || "—" },
      { label: "Amount", width: 115, align: "right", render: (r) => fmt(r.amount as string), bold: true },
    ];
    const table = new ReportTable(doc, cols, { margin, contentW, rowH: 18 });
    y = table.drawHeader(y);
    y = table.render(data.recentPayments as unknown as Array<Record<string, unknown>>, y);
    y += 6;
  }

  if (y + 90 > doc.page.height - 80) { doc.addPage(); y = margin; }
  y = drawSectionHeader(doc, "Summary", margin, y, contentW);
  const rows: Array<[string, string]> = [
    ["Total Received", data.totalReceived],
    ["Total Paid to Suppliers", data.totalMade],
    ["Total Expenses", data.totalExpenses],
  ];
  rows.forEach(([label, value]) => {
    if (y + 18 > doc.page.height - 70) { doc.addPage(); y = margin; }
    doc.fontSize(8).fillColor(PDF_COLORS.secondary).font("NotoSans")
      .text(label, margin + 4, y + 4, { width: 400, lineBreak: false });
    doc.fillColor(PDF_COLORS.primary).font("NotoSans-Bold")
      .text(fmt(value), margin + 404, y + 4, { width: contentW - 404, align: "right", lineBreak: false });
    y += 18;
  });
  const net = parseFloat(data.netCashMovement);
  doc.rect(margin, y, contentW, 22).fill(net >= 0 ? "#e7f5ec" : "#fdecec");
  doc.fontSize(8.5).fillColor(net >= 0 ? PDF_COLORS.credit : PDF_COLORS.debit).font("NotoSans-Bold");
  doc.text("Net Cash Movement", margin + 6, y + 7, { width: contentW - 200, lineBreak: false });
  doc.text(fmt(data.netCashMovement), margin + contentW - 200, y + 7, { width: 190, align: "right", lineBreak: false });

  return finalizeReportDoc(doc, margin, contentW);
}


// ── Item-wise Sales ─────────────────────────────────────────────────────

export interface ItemSalesRow {
  itemName: string;
  category: string | null;
  unit: string | null;
  soldQty: string;
  totalRevenue: string;
  avgUnitPrice: string;
  invoiceCount: number;
  uniqueCustomers: number;
}

export interface ItemSalesPDFData {
  businessName: string;
  fromDate: string;
  toDate: string;
  rows: ItemSalesRow[];
  totalRevenue: string;
  count: number;
}

export function generateItemSalesPDF(data: ItemSalesPDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: "Item-wise Sales",
    period: `${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
    meta: [`Items: ${fmtNum(data.count)}`],
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    landscape: true,
    title: "Item-wise Sales",
    subject: `Item-wise sales for ${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  });
  let y = startY;

  const cols: ColumnDef[] = [
    { label: "Item", width: 230, render: (r) => (r.itemName as string) || "—" },
    { label: "Qty", width: 80, align: "right", render: (r) => fmtNum(r.soldQty as string) },
    { label: "Revenue", width: 115, align: "right", render: (r) => fmt(r.totalRevenue as string), bold: true },
    { label: "Avg Price", width: 105, align: "right", render: (r) => fmt(r.avgUnitPrice as string) },
    { label: "Invoices", width: 75, align: "right", render: (r) => fmtNum(r.invoiceCount as number) },
    { label: "Customers", width: 80, align: "right", render: (r) => fmtNum(r.uniqueCustomers as number) },
  ];

  const table = new ReportTable(doc, cols, { margin, contentW, rowH: 18 });
  y = table.drawHeader(y);
  y = table.render(data.rows as unknown as Array<Record<string, unknown>>, y);
  y += 8;

  if (y + 22 > doc.page.height - 80) { doc.addPage(); y = margin; }
  doc.rect(margin, y, contentW, 22).fill(PDF_COLORS.primary);
  doc.fontSize(8).fillColor("#ffffff").font("NotoSans-Bold");
  doc.text(`Total Revenue (${fmtNum(data.count)} items)`, margin + 4, y + 7, { width: 500, lineBreak: false });
  doc.text(fmt(data.totalRevenue), margin + contentW - 150, y + 7, { width: 140, align: "right", lineBreak: false });

  return finalizeReportDoc(doc, margin, contentW);
}

// ── Collection Efficiency ───────────────────────────────────────────────

export interface CollectionEfficiencyPDFData {
  businessName: string;
  fromDate: string;
  toDate: string;
  collectionEfficiency: {
    totalInvoices: number;
    paidOnTime: number;
    paidLate: number;
    onTimeRate: string;
  };
  dso: {
    dsoDays: string | null;
    totalSales: string;
    avgReceivable: string;
    daysInPeriod: number;
  };
}

export function generateCollectionEfficiencyPDF(data: CollectionEfficiencyPDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: "Collection Efficiency",
    period: `${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    title: "Collection Efficiency",
    subject: `Collection efficiency for ${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  });
  let y = startY;

  const metricRows: Array<[string, string]> = [
    ["Total Paid Invoices", fmtNum(data.collectionEfficiency.totalInvoices)],
    ["Paid On Time", fmtNum(data.collectionEfficiency.paidOnTime)],
    ["Paid Late", fmtNum(data.collectionEfficiency.paidLate)],
    ["On-Time Rate", `${parseFloat(data.collectionEfficiency.onTimeRate || "0").toFixed(1)}%`],
    ["Days Sales Outstanding", data.dso.dsoDays === null ? "—" : `${parseFloat(data.dso.dsoDays).toFixed(1)} days`],
    ["Total Sales (period)", fmt(data.dso.totalSales)],
    ["Avg Receivable", fmt(data.dso.avgReceivable)],
    ["Days in Period", fmtNum(data.dso.daysInPeriod)],
  ];
  metricRows.forEach(([label, value], i) => {
    if (y + 18 > doc.page.height - 70) { doc.addPage(); y = margin; }
    if (i % 2 === 1) doc.rect(margin, y, contentW, 18).fill(PDF_COLORS.bg);
    doc.fontSize(8.5).fillColor(PDF_COLORS.secondary).font("NotoSans")
      .text(label, margin + 6, y + 5, { width: contentW - 200, lineBreak: false });
    doc.fillColor(PDF_COLORS.primary).font("NotoSans-Bold")
      .text(value, margin + contentW - 200, y + 5, { width: 190, align: "right", lineBreak: false });
    y += 18;
  });

  return finalizeReportDoc(doc, margin, contentW);
}


// ── Cash Flow Statement ─────────────────────────────────────────────────

export interface CashFlowLine {
  description: string;
  amount: string;
}

export interface CashFlowPDFData {
  businessName: string;
  fromDate: string;
  toDate: string;
  operating: {
    netIncome: string;
    adjustments: CashFlowLine[];
    workingCapitalChanges: CashFlowLine[];
    totalOperating: string;
  };
  investing: { items: CashFlowLine[]; totalInvesting: string };
  financing: { items: CashFlowLine[]; totalFinancing: string };
  netCashFlow: string;
  openingCashBalance: string;
  closingCashBalance: string;
}

export function generateCashFlowPDF(data: CashFlowPDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: "Cash Flow Statement",
    period: `${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    title: "Cash Flow Statement",
    subject: `Cash flow for ${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  });
  let y = startY;

  const colNameW = contentW - 150;
  const colAmt = 150;

  function line(descText: string, amount: string): number {
    if (y + 17 > doc.page.height - 70) { doc.addPage(); y = margin; }
    const n = parseFloat(amount);
    doc.fontSize(7.5).fillColor(PDF_COLORS.primary).font("NotoSans")
      .text(descText, margin + 12, y + 4.5, { width: colNameW - 12, lineBreak: false });
    doc.fillColor(n >= 0 ? PDF_COLORS.credit : PDF_COLORS.debit)
      .text(fmt(amount), margin + colNameW + 4, y + 4.5, { width: colAmt - 8, align: "right", lineBreak: false });
    y += 17;
    return y;
  }

  function totalRow(label: string, amount: string): number {
    if (y + 20 > doc.page.height - 80) { doc.addPage(); y = margin; }
    doc.rect(margin, y, contentW, 20).fill(PDF_COLORS.bg);
    doc.fontSize(8).fillColor(PDF_COLORS.primary).font("NotoSans-Bold");
    doc.text(label, margin + 6, y + 6, { width: colNameW - 6, lineBreak: false });
    doc.text(fmt(amount), margin + colNameW + 4, y + 6, { width: colAmt - 8, align: "right", lineBreak: false });
    y += 20 + 6;
    return y;
  }

  y = drawSectionHeader(doc, "A. Operating Activities", margin, y, contentW);
  y = line("Net Income", data.operating.netIncome);
  for (const a of data.operating.adjustments) y = line(a.description, a.amount);
  if (data.operating.workingCapitalChanges.length > 0) {
    y = drawSectionHeader(doc, "Working Capital Changes", margin, y, contentW);
    for (const w of data.operating.workingCapitalChanges) y = line(w.description, w.amount);
  }
  y = totalRow("Net Cash from Operating Activities", data.operating.totalOperating);

  y = drawSectionHeader(doc, "B. Investing Activities", margin, y, contentW);
  if (data.investing.items.length === 0) {
    doc.fontSize(7.5).fillColor(PDF_COLORS.muted).font("NotoSans")
      .text("No investing activities in this period.", margin + 12, y + 2, { width: contentW - 12, lineBreak: false });
    y += 16;
  }
  for (const item of data.investing.items) y = line(item.description, item.amount);
  y = totalRow("Net Cash from Investing Activities", data.investing.totalInvesting);

  y = drawSectionHeader(doc, "C. Financing Activities", margin, y, contentW);
  if (data.financing.items.length === 0) {
    doc.fontSize(7.5).fillColor(PDF_COLORS.muted).font("NotoSans")
      .text("No financing activities in this period.", margin + 12, y + 2, { width: contentW - 12, lineBreak: false });
    y += 16;
  }
  for (const item of data.financing.items) y = line(item.description, item.amount);
  y = totalRow("Net Cash from Financing Activities", data.financing.totalFinancing);

  y += 4;
  if (y + 66 > doc.page.height - 80) { doc.addPage(); y = margin; }
  y = totalRow("Opening Cash Balance", data.openingCashBalance);
  y = totalRow("Net Cash Flow", data.netCashFlow);
  if (y + 22 > doc.page.height - 80) { doc.addPage(); y = margin; }
  doc.rect(margin, y, contentW, 22).fill(PDF_COLORS.primary);
  doc.fontSize(8.5).fillColor("#ffffff").font("NotoSans-Bold");
  doc.text("Closing Cash Balance", margin + 6, y + 7, { width: colNameW - 6, lineBreak: false });
  doc.text(fmt(data.closingCashBalance), margin + colNameW + 4, y + 7, { width: colAmt - 8, align: "right", lineBreak: false });

  return finalizeReportDoc(doc, margin, contentW);
}
