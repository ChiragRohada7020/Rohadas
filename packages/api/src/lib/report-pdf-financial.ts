/**
 * report-pdf-financial.ts — Trial Balance, Profit & Loss and Balance Sheet.
 *
 * These three renderers are the "statutory" core of the reporting suite. They
 * render the exact aggregates produced by the tRPC reports router (which are
 * themselves derived from the virtual double-entry ledger — see derive-ledger.ts),
 * so the printed numbers always match the on-screen numbers.
 */

import {
  PDF_COLORS,
  createReportDoc,
  finalizeReportDoc,
  drawSectionHeader,
  fmt,
  fmtDate,
  type ReportHeaderInfo,
} from "./report-pdf-base.js";

// ── Shared data types ───────────────────────────────────────────────────

export interface TrialBalanceAccount {
  accountCode: string;
  accountName: string;
  accountType: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface TrialBalancePDFData {
  businessName: string;
  asOfDate: string;
  accounts: TrialBalanceAccount[];
  totalDebit: string;
  totalCredit: string;
}

export interface PlItem {
  accountCode: string;
  accountName: string;
  amount: string;
}

export interface ProfitLossPDFData {
  businessName: string;
  fromDate: string;
  toDate: string;
  income: PlItem[];
  expenses: PlItem[];
  totalIncome: string;
  totalExpenses: string;
  grossProfit: string;
  netProfit: string;
}

export interface BsItem {
  accountCode: string;
  accountName: string;
  balance: string;
}

export interface BalanceSheetPDFData {
  businessName: string;
  asOfDate: string;
  assets: BsItem[];
  liabilities: BsItem[];
  equity: BsItem[];
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
}

// ── Account type ordering ────────────────────────────────────────────────
const TYPE_ORDER: Record<string, number> = {
  asset: 1,
  liability: 2,
  equity: 3,
  income: 4,
  expense: 5,
};
const TYPE_LABEL: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

// ── Trial Balance ───────────────────────────────────────────────────────

export function generateTrialBalancePDF(data: TrialBalancePDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: "Trial Balance",
    period: `As of ${fmtDate(data.asOfDate)}`,
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    title: "Trial Balance",
    subject: `Trial Balance as of ${fmtDate(data.asOfDate)}`,
  });
  let y = startY;

  const grouped = new Map<string, TrialBalanceAccount[]>();
  for (const a of data.accounts) {
    const list = grouped.get(a.accountType) ?? [];
    list.push(a);
    grouped.set(a.accountType, list);
  }
  const orderedTypes = [...grouped.keys()].sort(
    (a, b) => (TYPE_ORDER[a] ?? 99) - (TYPE_ORDER[b] ?? 99),
  );

  const colCode = 50;
  const colDebit = 95;
  const colCredit = 95;
  const colBal = 95;
  const colNameW = contentW - (colCode + colDebit + colCredit + colBal);

  for (const type of orderedTypes) {
    const rows = grouped.get(type) ?? [];
    if (rows.length === 0) continue;
    y = drawSectionHeader(doc, TYPE_LABEL[type] ?? type, margin, y, contentW);
    if (y > doc.page.height - 90) { doc.addPage(); y = margin; }

    doc.rect(margin, y, contentW, 18).fill(PDF_COLORS.primary);
    doc.fontSize(7.5).fillColor("#ffffff").font("NotoSans-Bold");
    let x = margin;
    doc.text("Code", x + 4, y + 5, { width: colCode - 8, lineBreak: false });
    x += colCode;
    doc.text("Account", x + 4, y + 5, { width: colNameW - 8, lineBreak: false });
    x += colNameW;
    doc.text("Debit", x + 4, y + 5, { width: colDebit - 8, align: "right", lineBreak: false });
    x += colDebit;
    doc.text("Credit", x + 4, y + 5, { width: colCredit - 8, align: "right", lineBreak: false });
    x += colCredit;
    doc.text("Balance", x + 4, y + 5, { width: colBal - 8, align: "right", lineBreak: false });
    y += 18;

    rows.forEach((a, i) => {
      if (y + 17 > doc.page.height - 70) { doc.addPage(); y = margin; }
      if (i % 2 === 1) doc.rect(margin, y, contentW, 17).fill(PDF_COLORS.bg);
      const balNum = parseFloat(a.balance);
      const balColor = balNum > 0 ? PDF_COLORS.debit : balNum < 0 ? PDF_COLORS.credit : PDF_COLORS.primary;
      x = margin;
      doc.fontSize(7.5).fillColor(PDF_COLORS.muted).font("NotoSans")
        .text(a.accountCode, x + 4, y + 4.5, { width: colCode - 8, lineBreak: false });
      x += colCode;
      doc.fillColor(PDF_COLORS.primary)
        .text(a.accountName, x + 4, y + 4.5, { width: colNameW - 8, lineBreak: false });
      x += colNameW;
      doc.text(fmt(a.debit), x + 4, y + 4.5, { width: colDebit - 8, align: "right", lineBreak: false });
      x += colDebit;
      doc.text(fmt(a.credit), x + 4, y + 4.5, { width: colCredit - 8, align: "right", lineBreak: false });
      x += colCredit;
      doc.font("NotoSans-Bold").fillColor(balColor)
        .text(fmt(a.balance), x + 4, y + 4.5, { width: colBal - 8, align: "right", lineBreak: false });
      y += 17;
    });
    y += 4;
  }

  if (y + 22 > doc.page.height - 80) { doc.addPage(); y = margin; }
  doc.rect(margin, y, contentW, 22).fill(PDF_COLORS.primary);
  doc.fontSize(8).fillColor("#ffffff").font("NotoSans-Bold");
  let x = margin + colCode;
  doc.text("Total", x + 4, y + 7, { width: colNameW - 8, lineBreak: false });
  x += colNameW;
  doc.text(fmt(data.totalDebit), x + 4, y + 7, { width: colDebit - 8, align: "right", lineBreak: false });
  x += colDebit;
  doc.text(fmt(data.totalCredit), x + 4, y + 7, { width: colCredit - 8, align: "right", lineBreak: false });
  y += 22 + 8;

  const balanced = Math.abs(parseFloat(data.totalDebit) - parseFloat(data.totalCredit)) < 0.005;
  doc.fontSize(7.5).fillColor(balanced ? PDF_COLORS.credit : PDF_COLORS.debit).font("NotoSans")
    .text(
      balanced ? "✓ Debit total equals credit total — books are balanced." : "⚠ Debit and credit totals differ.",
      margin, y, { width: contentW, lineBreak: false },
    );

  return finalizeReportDoc(doc, margin, contentW);
}

// ── Profit & Loss ───────────────────────────────────────────────────────

export function generateProfitAndLossPDF(data: ProfitLossPDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: "Profit & Loss Statement",
    period: `${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    title: "Profit & Loss Statement",
    subject: `P&L for ${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`,
  });
  let y = startY;

  const colNameW = contentW - 140;
  const colAmt = 140;

  function renderLines(items: PlItem[], label: string): number {
    if (items.length === 0) return y;
    y = drawSectionHeader(doc, label, margin, y, contentW);
    doc.rect(margin, y, contentW, 18).fill(PDF_COLORS.primary);
    doc.fontSize(7.5).fillColor("#ffffff").font("NotoSans-Bold");
    doc.text("Account", margin + 4, y + 5, { width: colNameW - 8, lineBreak: false });
    doc.text("Amount (₹)", margin + colNameW + 4, y + 5, { width: colAmt - 8, align: "right", lineBreak: false });
    y += 18;
    items.forEach((it, i) => {
      if (y + 17 > doc.page.height - 70) { doc.addPage(); y = margin; }
      if (i % 2 === 1) doc.rect(margin, y, contentW, 17).fill(PDF_COLORS.bg);
      doc.fontSize(7.5).fillColor(PDF_COLORS.primary).font("NotoSans")
        .text(`${it.accountCode} — ${it.accountName}`, margin + 4, y + 4.5, { width: colNameW - 8, lineBreak: false });
      doc.text(fmt(it.amount), margin + colNameW + 4, y + 4.5, { width: colAmt - 8, align: "right", lineBreak: false });
      y += 17;
    });
    y += 4;
    return y;
  }

  function renderTotal(label: string, value: string, opts: { dark?: boolean } = {}): number {
    if (y + 20 > doc.page.height - 80) { doc.addPage(); y = margin; }
    doc.rect(margin, y, contentW, 20).fill(opts.dark ? PDF_COLORS.primary : PDF_COLORS.bg);
    doc.fontSize(8).fillColor(opts.dark ? "#ffffff" : PDF_COLORS.primary).font("NotoSans-Bold");
    doc.text(label, margin + 4, y + 6, { width: colNameW - 8, lineBreak: false });
    doc.text(fmt(value), margin + colNameW + 4, y + 6, { width: colAmt - 8, align: "right", lineBreak: false });
    y += 20 + 6;
    return y;
  }

  y = renderLines(data.income, "Revenue");
  y = renderTotal("Total Income", data.totalIncome);
  y += 4;
  y = renderLines(data.expenses, "Expenses");
  y = renderTotal("Total Expenses", data.totalExpenses);
  y += 6;
  y = renderTotal("Gross Profit", data.grossProfit);

  if (y + 24 > doc.page.height - 80) { doc.addPage(); y = margin; }
  const np = parseFloat(data.netProfit);
  doc.rect(margin, y, contentW, 24).fill(np >= 0 ? "#e7f5ec" : "#fdecec");
  doc.fontSize(9).fillColor(np >= 0 ? PDF_COLORS.credit : PDF_COLORS.debit).font("NotoSans-Bold");
  doc.text("Net Profit / (Loss)", margin + 6, y + 7, { width: colNameW - 12, lineBreak: false });
  doc.text(fmt(data.netProfit), margin + colNameW + 4, y + 7, { width: colAmt - 8, align: "right", lineBreak: false });

  return finalizeReportDoc(doc, margin, contentW);
}



// ── Balance Sheet ───────────────────────────────────────────────────────

export function generateBalanceSheetPDF(data: BalanceSheetPDFData): Promise<Buffer> {
  const header: ReportHeaderInfo = {
    businessName: data.businessName,
    title: "Balance Sheet",
    period: `As of ${fmtDate(data.asOfDate)}`,
  };
  const { doc, margin, contentW, y: startY } = createReportDoc(header, {
    title: "Balance Sheet",
    subject: `Balance Sheet as of ${fmtDate(data.asOfDate)}`,
  });
  let y = startY;

  const colNameW = contentW - 150;
  const colAmt = 150;

  function renderSection(label: string, items: BsItem[], total: string): number {
    y = drawSectionHeader(doc, label, margin, y, contentW);
    if (y + 18 > doc.page.height - 90) { doc.addPage(); y = margin; }
    doc.rect(margin, y, contentW, 18).fill(PDF_COLORS.primary);
    doc.fontSize(7.5).fillColor("#ffffff").font("NotoSans-Bold");
    doc.text("Account", margin + 4, y + 5, { width: colNameW - 8, lineBreak: false });
    doc.text("Amount (₹)", margin + colNameW + 4, y + 5, { width: colAmt - 8, align: "right", lineBreak: false });
    y += 18;

    items.forEach((it, i) => {
      if (y + 17 > doc.page.height - 70) { doc.addPage(); y = margin; }
      if (i % 2 === 1) doc.rect(margin, y, contentW, 17).fill(PDF_COLORS.bg);
      doc.fontSize(7.5).fillColor(PDF_COLORS.primary).font("NotoSans")
        .text(`${it.accountCode} — ${it.accountName}`, margin + 4, y + 4.5, { width: colNameW - 8, lineBreak: false });
      doc.text(fmt(it.balance), margin + colNameW + 4, y + 4.5, { width: colAmt - 8, align: "right", lineBreak: false });
      y += 17;
    });

    if (y + 20 > doc.page.height - 80) { doc.addPage(); y = margin; }
    doc.rect(margin, y, contentW, 20).fill(PDF_COLORS.bg);
    doc.fontSize(8).fillColor(PDF_COLORS.primary).font("NotoSans-Bold");
    doc.text(`Total ${label}`, margin + 4, y + 6, { width: colNameW - 8, lineBreak: false });
    doc.text(fmt(total), margin + colNameW + 4, y + 6, { width: colAmt - 8, align: "right", lineBreak: false });
    y += 20 + 8;
    return y;
  }

  y = renderSection("Assets", data.assets, data.totalAssets);
  y = renderSection("Liabilities", data.liabilities, data.totalLiabilities);
  y = renderSection("Equity", data.equity, data.totalEquity);

  const liabPlusEquity = parseFloat(data.totalLiabilities) + parseFloat(data.totalEquity);
  const balanced = Math.abs(parseFloat(data.totalAssets) - liabPlusEquity) < 0.01;
  y += 4;
  doc.fontSize(7.5).fillColor(balanced ? PDF_COLORS.credit : PDF_COLORS.debit).font("NotoSans")
    .text(
      balanced
        ? `✓ Assets (${fmt(data.totalAssets)}) equal Liabilities + Equity (${fmt(String(liabPlusEquity.toFixed(2)))}).`
        : `⚠ Assets (${fmt(data.totalAssets)}) differ from Liabilities + Equity (${fmt(String(liabPlusEquity.toFixed(2)))}).`,
      margin, y, { width: contentW, lineBreak: false },
    );

  return finalizeReportDoc(doc, margin, contentW);
}
