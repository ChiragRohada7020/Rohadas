/**
 * report-pdf-service.ts — assembles report data and renders report PDFs.
 *
 * WHY THIS FILE EXISTS:
 * The HTTP route (`GET /api/reports/:type.pdf`) and any future email/WhatsApp
 * report deliveries all need the identical PDF. Keeping the query + mapping in
 * one place stops the download and any emailed copy from drifting apart.
 *
 * Data sourcing mirrors the tRPC `reports` / `gst` routers exactly:
 *   - Financial reports (trial balance, P&L, balance sheet) derive from the
 *     virtual double-entry ledger (deriveFullLedger), the same engine the
 *     on-screen reports use.
 *   - GST working summaries reuse generateGSTR1 / generateGSTR3B.
 *   - Operational reports run the same drizzle queries as the reports router.
 */

import { eq, and, sql, isNull, desc } from "drizzle-orm";
import {
  invoices,
  invoiceItems,
  payments,
  expenses,
  parties,
  items,
  itemVariants,
  chartOfAccounts,
  businesses,
  bankAccounts,
} from "@hisaabo/db";
import type { TenantDatabase } from "@hisaabo/db";
import { money } from "@hisaabo/shared";
import { buildBusinessDateFilter } from "./business-date.js";
import { deriveFullLedger, deriveLedger } from "./derive-ledger.js";
import { generateGSTR1, generateGSTR3B } from "./gst-reports.js";
import { generateTrialBalancePDF, generateProfitAndLossPDF, generateBalanceSheetPDF } from "./report-pdf-financial.js";
import {
  generateDaybookPDF,
  generateRegisterPDF,
  generateOutstandingPDF,
  generateStockSummaryPDF,
  generateGeneralLedgerPDF,
  generateTaxSummaryPDF,
  generatePaymentSummaryPDF,
  generateItemSalesPDF,
  generateCollectionEfficiencyPDF,
  generateCashFlowPDF,
} from "./report-pdf-tabular.js";
import { generateGSTR1PDF, generateGSTR3BPDF } from "./report-pdf-gst.js";

export interface ReportPdfBundle {
  pdfBuffer: Buffer;
  fileName: string;
  businessName: string;
}

export type ReportPdfType =
  | "trial-balance"
  | "profit-loss"
  | "balance-sheet"
  | "daybook"
  | "sales-register"
  | "purchase-register"
  | "outstanding"
  | "stock-summary"
  | "general-ledger"
  | "tax-summary"
  | "payment-summary"
  | "item-sales"
  | "collection-efficiency"
  | "cash-flow"
  | "gstr1"
  | "gstr3b";

export const REPORT_PDF_TYPES: ReportPdfType[] = [
  "trial-balance",
  "profit-loss",
  "balance-sheet",
  "daybook",
  "sales-register",
  "purchase-register",
  "outstanding",
  "stock-summary",
  "general-ledger",
  "tax-summary",
  "payment-summary",
  "item-sales",
  "collection-efficiency",
  "cash-flow",
  "gstr1",
  "gstr3b",
];

export interface ReportPdfFilters {
  fromDate?: string;
  toDate?: string;
  asOfDate?: string;
  partyId?: string;
  accountId?: string;
  type?: string; // daybook typeFilter / outstanding type / tax/payment summary type
  year?: number;
  month?: number;
  showZeroStock?: boolean;
  category?: string;
  bankAccountId?: string;
}


// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = TenantDatabase;

async function getBusinessName(db: Db, businessId: string): Promise<string> {
  const [biz] = await db.select({ name: businesses.name })
    .from(businesses).where(eq(businesses.id, businessId)).limit(1);
  return biz?.name ?? "Business";
}

// ── Financial report data (mirrors reports router) ──────────────────────

async function loadTrialBalance(db: Db, businessId: string, asOfDate: string) {
  const asOf = new Date(asOfDate);
  const [biz] = await db
    .select({ financialYearStart: businesses.financialYearStart })
    .from(businesses).where(eq(businesses.id, businessId)).limit(1);
  const fyStartMonth = (biz?.financialYearStart ?? 4) - 1;
  const fyYear = asOf.getMonth() < fyStartMonth ? asOf.getFullYear() - 1 : asOf.getFullYear();
  const from = new Date(fyYear, fyStartMonth, 1);

  const entries = await deriveFullLedger(db, businessId, from, asOf, { includeOpeningBalances: true });

  const accountMap = new Map<string, { debit: string; credit: string; code: string; name: string }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const existing = accountMap.get(line.accountCode) ?? { debit: "0.00", credit: "0.00", code: line.accountCode, name: line.accountName };
      existing.debit = money.add(existing.debit, line.debit);
      existing.credit = money.add(existing.credit, line.credit);
      accountMap.set(line.accountCode, existing);
    }
  }

  const coaRows = await db
    .select({ code: chartOfAccounts.code, accountType: chartOfAccounts.accountType })
    .from(chartOfAccounts).where(eq(chartOfAccounts.businessId, businessId));
  const coaTypeMap = new Map(coaRows.map((r: { code: string; accountType: string }) => [r.code, r.accountType]));

  const accounts = [...accountMap.values()].map((a) => ({
    accountCode: a.code,
    accountName: a.name,
    accountType: coaTypeMap.get(a.code) ?? "expense",
    debit: a.debit,
    credit: a.credit,
    balance: money.sub(a.debit, a.credit),
  })).sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  return {
    accounts,
    totalDebit: money.sum(accounts.map((a) => a.debit)),
    totalCredit: money.sum(accounts.map((a) => a.credit)),
  };
}


async function loadProfitAndLoss(db: Db, businessId: string, fromDate: string, toDate: string) {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const entries = await deriveFullLedger(db, businessId, from, to);

  const coaRows = await db
    .select({ code: chartOfAccounts.code, name: chartOfAccounts.name, accountType: chartOfAccounts.accountType })
    .from(chartOfAccounts).where(eq(chartOfAccounts.businessId, businessId));
  const coaTypeMap = new Map(coaRows.map((r: { code: string; name: string; accountType: string }) => [r.code, { name: r.name, type: r.accountType }]));

  const accountMap = new Map<string, { debit: string; credit: string }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const existing = accountMap.get(line.accountCode) ?? { debit: "0.00", credit: "0.00" };
      existing.debit = money.add(existing.debit, line.debit);
      existing.credit = money.add(existing.credit, line.credit);
      accountMap.set(line.accountCode, existing);
    }
  }

  const income: Array<{ accountCode: string; accountName: string; amount: string }> = [];
  const expenseItems: Array<{ accountCode: string; accountName: string; amount: string }> = [];

  for (const [code, acctInfo] of coaTypeMap) {
    if (acctInfo.type !== "income" && acctInfo.type !== "expense") continue;
    const acc = accountMap.get(code);
    if (acctInfo.type === "income") {
      income.push({ accountCode: code, accountName: acctInfo.name, amount: acc ? money.sub(acc.credit, acc.debit) : "0.00" });
    } else {
      expenseItems.push({ accountCode: code, accountName: acctInfo.name, amount: acc ? money.sub(acc.debit, acc.credit) : "0.00" });
    }
  }
  income.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  expenseItems.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  const totalIncome = money.sum(income.map((a) => a.amount));
  const totalExpenses = money.sum(expenseItems.map((a) => a.amount));

  const salesAmt = income.find((a) => a.accountCode === "4000")?.amount ?? "0.00";
  const salesReturnsAmt = income.find((a) => a.accountCode === "4010")?.amount ?? "0.00";
  const purchasesAmt = expenseItems.find((a) => a.accountCode === "5000")?.amount ?? "0.00";
  const directExpAmt = expenseItems.find((a) => a.accountCode === "5100")?.amount ?? "0.00";
  const grossProfit = money.sub(money.add(salesAmt, salesReturnsAmt), money.add(purchasesAmt, directExpAmt));
  const netProfit = money.sub(totalIncome, totalExpenses);

  return { income, expenses: expenseItems, totalIncome, totalExpenses, grossProfit, netProfit };
}


async function loadBalanceSheet(db: Db, businessId: string, asOfDate: string) {
  const asOf = new Date(asOfDate);
  const allEntries = await deriveFullLedger(db, businessId, new Date("2000-01-01"), asOf, { includeOpeningBalances: true });

  const coaRows = await db
    .select({ code: chartOfAccounts.code, name: chartOfAccounts.name, accountType: chartOfAccounts.accountType })
    .from(chartOfAccounts).where(eq(chartOfAccounts.businessId, businessId));
  const coaTypeMap = new Map(coaRows.map((r: { code: string; name: string; accountType: string }) => [r.code, { name: r.name, type: r.accountType }]));

  const allMap = new Map<string, { debit: string; credit: string }>();
  for (const entry of allEntries) {
    for (const line of entry.lines) {
      const existing = allMap.get(line.accountCode) ?? { debit: "0.00", credit: "0.00" };
      existing.debit = money.add(existing.debit, line.debit);
      existing.credit = money.add(existing.credit, line.credit);
      allMap.set(line.accountCode, existing);
    }
  }

  let totalIncomeCredits = "0.00", totalIncomeDebits = "0.00";
  let totalExpenseDebits = "0.00", totalExpenseCredits = "0.00";
  for (const [code, acc] of allMap) {
    const acctInfo = coaTypeMap.get(code);
    if (!acctInfo) continue;
    if (acctInfo.type === "income") {
      totalIncomeCredits = money.add(totalIncomeCredits, acc.credit);
      totalIncomeDebits = money.add(totalIncomeDebits, acc.debit);
    } else if (acctInfo.type === "expense") {
      totalExpenseDebits = money.add(totalExpenseDebits, acc.debit);
      totalExpenseCredits = money.add(totalExpenseCredits, acc.credit);
    }
  }
  const netIncome = money.sub(
    money.sub(totalIncomeCredits, totalIncomeDebits),
    money.sub(totalExpenseDebits, totalExpenseCredits),
  );

  type BsItem = { accountCode: string; accountName: string; balance: string };
  const assets: BsItem[] = [];
  const liabilities: BsItem[] = [];
  const equity: BsItem[] = [];

  for (const [code, acctInfo] of coaTypeMap) {
    const { type } = acctInfo;
    if (type !== "asset" && type !== "liability" && type !== "equity") continue;
    const acc = allMap.get(code);
    if (type === "asset") {
      assets.push({ accountCode: code, accountName: acctInfo.name, balance: acc ? money.sub(acc.debit, acc.credit) : "0.00" });
    } else if (type === "liability") {
      liabilities.push({ accountCode: code, accountName: acctInfo.name, balance: acc ? money.sub(acc.credit, acc.debit) : "0.00" });
    } else {
      equity.push({ accountCode: code, accountName: acctInfo.name, balance: acc ? money.sub(acc.credit, acc.debit) : "0.00" });
    }
  }
  assets.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  liabilities.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  equity.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  equity.push({ accountCode: "9999", accountName: "Net Income (Current Period)", balance: netIncome });

  return {
    assets,
    liabilities,
    equity,
    totalAssets: money.sum(assets.map((a) => a.balance)),
    totalLiabilities: money.sum(liabilities.map((a) => a.balance)),
    totalEquity: money.sum(equity.map((a) => a.balance)),
  };
}


// ── Operational report data ─────────────────────────────────────────────

async function loadDaybook(db: Db, businessId: string, fromDate: string, toDate: string, typeFilter?: string) {
  const dayStart = new Date(`${fromDate.slice(0, 10)}T00:00:00`);
  const dayEnd = new Date(`${toDate.slice(0, 10)}T23:59:59.999`);

  const [dayInvoices, dayPayments, dayExpenses] = await Promise.all([
    typeFilter === "payments" || typeFilter === "expenses"
      ? []
      : db.select({
          id: invoices.id,
          time: invoices.invoiceDate,
          number: invoices.invoiceNumber,
          type: invoices.type,
          documentType: invoices.documentType,
          partyName: parties.name,
          totalAmount: invoices.totalAmount,
          status: invoices.status,
        })
        .from(invoices).innerJoin(parties, eq(parties.id, invoices.partyId))
        .where(and(eq(invoices.businessId, businessId), ...buildBusinessDateFilter(invoices, { from: dayStart, to: dayEnd }), isNull(invoices.deletedAt)))
        .orderBy(invoices.invoiceDate),

    typeFilter === "invoices" || typeFilter === "expenses"
      ? []
      : db.select({
          id: payments.id,
          time: payments.paymentDate,
          number: payments.paymentNumber,
          partyName: parties.name,
          partyType: parties.type,
          amount: payments.amount,
          mode: payments.mode,
          settledType: sql<string | null>`(SELECT i.type FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id WHERE pa.payment_id = payments.id ORDER BY pa.id LIMIT 1)`,
          legacySettledType: sql<string | null>`(SELECT i.type FROM invoices i WHERE i.id = payments.invoice_id)`,
        })
        .from(payments).innerJoin(parties, eq(parties.id, payments.partyId))
        .where(and(eq(payments.businessId, businessId), ...buildBusinessDateFilter(payments, { from: dayStart, to: dayEnd }), isNull(payments.deletedAt)))
        .orderBy(payments.paymentDate),

    typeFilter === "invoices" || typeFilter === "payments"
      ? []
      : db.select({
          id: expenses.id,
          time: expenses.expenseDate,
          category: expenses.category,
          description: expenses.description,
          amount: expenses.amount,
          mode: expenses.mode,
        })
        .from(expenses)
        .where(and(eq(expenses.businessId, businessId), ...buildBusinessDateFilter(expenses, { from: dayStart, to: dayEnd }), isNull(expenses.deletedAt)))
        .orderBy(expenses.expenseDate),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries: any[] = [
    ...(dayInvoices as any[]).map((inv) => ({
      time: inv.time,
      entryType: "invoice" as const,
      number: inv.number,
      partyOrCategory: inv.partyName,
      debit: inv.type === "purchase" ? inv.totalAmount : "0",
      credit: inv.type === "sale" ? inv.totalAmount : "0",
      mode: null,
      status: inv.status,
    })),
    ...(dayPayments as any[]).map((pmt) => {
      const settled = pmt.settledType ?? pmt.legacySettledType;
      const isMoneyIn = settled ? settled === "sale" : pmt.partyType === "customer";
      return {
        time: pmt.time,
        entryType: "payment" as const,
        number: pmt.number ?? null,
        partyOrCategory: pmt.partyName,
        debit: isMoneyIn ? "0" : pmt.amount,
        credit: isMoneyIn ? pmt.amount : "0",
        mode: pmt.mode,
        status: null,
      };
    }),
    ...(dayExpenses as any[]).map((exp) => ({
      time: exp.time,
      entryType: "expense" as const,
      number: null,
      partyOrCategory: exp.category,
      debit: exp.amount,
      credit: "0",
      mode: exp.mode,
      status: null,
    })),
  ].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const totalSalesInvoiced = money.sum((dayInvoices as any[]).filter((i) => i.type === "sale").map((i) => i.totalAmount));
  const totalPurchaseInvoiced = money.sum((dayInvoices as any[]).filter((i) => i.type === "purchase").map((i) => i.totalAmount));
  const isDayPaymentIn = (p: any) => { const s = p.settledType ?? p.legacySettledType; return s ? s === "sale" : p.partyType === "customer"; };
  const totalPaymentsReceived = money.sum((dayPayments as any[]).filter(isDayPaymentIn).map((p) => p.amount));
  const totalPaymentsMade = money.sum((dayPayments as any[]).filter((p) => !isDayPaymentIn(p)).map((p) => p.amount));
  const totalExpenses = money.sum((dayExpenses as any[]).map((e) => e.amount));

  return {
    entries,
    summary: {
      totalSalesInvoiced,
      totalPurchaseInvoiced,
      totalPaymentsReceived,
      totalPaymentsMade,
      totalExpenses,
      netCashMovement: money.sub(money.sub(totalPaymentsReceived, totalPaymentsMade), totalExpenses),
    },
  };
}


async function loadRegister(db: Db, businessId: string, type: "sale" | "purchase", fromDate: string, toDate: string, partyId?: string) {
  const conditions = [
    eq(invoices.businessId, businessId),
    eq(invoices.type, type),
    ...(type === "sale"
      ? [sql`${invoices.documentType} IN ('invoice', 'credit_note', 'debit_note')`]
      : [eq(invoices.documentType, "invoice")]),
    sql`${invoices.status} != 'cancelled'`,
    isNull(invoices.deletedAt),
    ...buildBusinessDateFilter(invoices, { from: fromDate, to: toDate }),
  ];
  if (partyId) conditions.push(eq(invoices.partyId, partyId));

  const rows = await db.select({
    id: invoices.id,
    invoiceDate: invoices.invoiceDate,
    invoiceNumber: invoices.invoiceNumber,
    partyName: parties.name,
    partyGstin: parties.gstin,
    subtotal: invoices.subtotal,
    discountAmount: invoices.discountAmount,
    taxAmount: invoices.taxAmount,
    totalAmount: invoices.totalAmount,
    amountPaid: invoices.amountPaid,
    status: invoices.status,
  })
    .from(invoices).innerJoin(parties, eq(parties.id, invoices.partyId))
    .where(and(...conditions))
    .orderBy(invoices.invoiceDate);

  const mapped = rows.map((r) => ({
    invoiceDate: r.invoiceDate,
    invoiceNumber: r.invoiceNumber,
    partyName: r.partyName,
    partyGstin: r.partyGstin,
    subtotal: r.subtotal,
    discountAmount: r.discountAmount,
    taxAmount: r.taxAmount,
    totalAmount: r.totalAmount,
    amountPaid: r.amountPaid,
    status: r.status,
  }));

  return {
    rows: mapped,
    summary: {
      totalSubtotal: money.sum(rows.map((r) => r.subtotal)),
      totalTax: money.sum(rows.map((r) => r.taxAmount)),
      totalAmount: money.sum(rows.map((r) => r.totalAmount)),
      count: rows.length,
    },
  };
}

async function loadOutstanding(db: Db, businessId: string, asOfDate: string, type?: string) {
  const asOf = new Date(asOfDate);

  async function fetchOutstanding(invoiceType: "sale" | "purchase") {
    return db.select({
      partyId: parties.id,
      partyName: parties.name,
      partyPhone: parties.phone,
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      dueDate: invoices.dueDate,
      totalAmount: invoices.totalAmount,
      amountPaid: invoices.amountPaid,
      outstanding: sql<string>`(${invoices.totalAmount}::numeric - ${invoices.amountPaid}::numeric)::text`,
      daysOverdue: sql<string>`GREATEST(0, EXTRACT(DAY FROM ${asOf.toISOString()}::timestamptz - COALESCE(${invoices.dueDate}, ${invoices.invoiceDate})))::text`,
    })
      .from(invoices).innerJoin(parties, eq(parties.id, invoices.partyId))
      .where(and(
        eq(invoices.businessId, businessId),
        eq(invoices.type, invoiceType),
        eq(invoices.documentType, "invoice"),
        sql`${invoices.status} NOT IN ('paid', 'cancelled', 'draft')`,
        sql`${invoices.totalAmount}::numeric - ${invoices.amountPaid}::numeric > 0`,
        isNull(invoices.deletedAt),
      ))
      .orderBy(parties.name, sql`COALESCE(${invoices.dueDate}, ${invoices.invoiceDate}) ASC`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildAgingBuckets(rows: any[]) {
    const partyMap = new Map<string, any>();
    for (const row of rows) {
      const days = parseFloat(row.daysOverdue);
      const outstanding = parseFloat(row.outstanding);
      const existing = partyMap.get(row.partyId) ?? {
        partyName: row.partyName, partyPhone: row.partyPhone,
        current: 0, days31_60: 0, days61_90: 0, days90Plus: 0, total: 0, invoices: [],
      };
      if (days <= 30) existing.current += outstanding;
      else if (days <= 60) existing.days31_60 += outstanding;
      else if (days <= 90) existing.days61_90 += outstanding;
      else existing.days90Plus += outstanding;
      existing.total += outstanding;
      existing.invoices.push(row);
      partyMap.set(row.partyId, existing);
    }
    const partiesList = [...partyMap.entries()].map(([, d]) => ({
      partyName: d.partyName, partyPhone: d.partyPhone,
      current: d.current.toFixed(2), days31_60: d.days31_60.toFixed(2),
      days61_90: d.days61_90.toFixed(2), days90Plus: d.days90Plus.toFixed(2),
      total: d.total.toFixed(2), invoices: d.invoices,
    })).sort((a, b) => parseFloat(b.total) - parseFloat(a.total));

    const summary = partiesList.reduce((acc, r) => ({
      current: (parseFloat(acc.current) + parseFloat(r.current)).toFixed(2),
      days31_60: (parseFloat(acc.days31_60) + parseFloat(r.days31_60)).toFixed(2),
      days61_90: (parseFloat(acc.days61_90) + parseFloat(r.days61_90)).toFixed(2),
      days90Plus: (parseFloat(acc.days90Plus) + parseFloat(r.days90Plus)).toFixed(2),
      total: (parseFloat(acc.total) + parseFloat(r.total)).toFixed(2),
    }), { current: "0", days31_60: "0", days61_90: "0", days90Plus: "0", total: "0" });

    return { parties: partiesList, summary };
  }

  if (type === "receivable") {
    return { receivables: buildAgingBuckets(await fetchOutstanding("sale")), payables: null };
  }
  if (type === "payable") {
    return { receivables: null, payables: buildAgingBuckets(await fetchOutstanding("purchase")) };
  }
  const [recv, pay] = await Promise.all([fetchOutstanding("sale"), fetchOutstanding("purchase")]);
  return { receivables: buildAgingBuckets(recv), payables: buildAgingBuckets(pay) };
}


async function loadStockSummary(db: Db, businessId: string, showZeroStock: boolean, category?: string) {
  const simpleConditions = [
    eq(items.businessId, businessId),
    eq(items.itemType, "product"),
    sql`${items.itemMode} != 'variants'`,
    isNull(items.deletedAt),
  ];
  if (!showZeroStock) simpleConditions.push(sql`${items.stockQuantity}::numeric != 0`);
  if (category) simpleConditions.push(eq(items.category, category));

  const variantConditions = [
    eq(items.businessId, businessId),
    eq(items.itemType, "product"),
    eq(items.itemMode, "variants"),
    isNull(items.deletedAt),
    isNull(itemVariants.deletedAt),
  ];
  if (category) variantConditions.push(eq(items.category, category));

  const [simpleRows, variantRows] = await Promise.all([
    db.select({
      itemId: items.id,
      itemName: items.name,
      category: items.category,
      hsn: items.hsn,
      unit: items.unit,
      currentStock: items.stockQuantity,
      purchasePrice: items.purchasePrice,
      salePrice: items.salePrice,
      stockValue: sql<string>`ROUND(GREATEST(${items.stockQuantity}::numeric, 0) * COALESCE(${items.purchasePrice}::numeric, 0), 2)::text`,
      stockValueAtSale: sql<string>`ROUND(GREATEST(${items.stockQuantity}::numeric, 0) * COALESCE(${items.salePrice}::numeric, 0), 2)::text`,
      lowStockAlert: items.lowStockAlert,
      isLowStock: sql<boolean>`${items.lowStockAlert} IS NOT NULL AND ${items.stockQuantity}::numeric <= ${items.lowStockAlert}::numeric`,
    }).from(items).where(and(...simpleConditions)).orderBy(items.name),

    db.select({
      itemId: items.id,
      itemName: items.name,
      category: items.category,
      hsn: items.hsn,
      unit: items.unit,
      totalStock: sql<string>`SUM(${itemVariants.stockQuantity}::numeric)::text`,
      totalValue: sql<string>`ROUND(SUM(GREATEST(${itemVariants.stockQuantity}::numeric, 0) * COALESCE(${itemVariants.purchasePrice}::numeric, 0)), 2)::text`,
      totalValueAtSale: sql<string>`ROUND(SUM(GREATEST(${itemVariants.stockQuantity}::numeric, 0) * COALESCE(${itemVariants.salePrice}::numeric, 0)), 2)::text`,
    }).from(items).innerJoin(itemVariants, eq(itemVariants.itemId, items.id))
      .where(and(...variantConditions))
      .groupBy(items.id, items.name, items.category, items.hsn, items.unit)
      .having(showZeroStock ? sql`TRUE` : sql`SUM(${itemVariants.stockQuantity}::numeric) != 0`)
      .orderBy(items.name),
  ]);

  const totalCostValue = (
    parseFloat(money.sum(simpleRows.map((r) => r.stockValue))) +
    parseFloat(money.sum(variantRows.map((r) => r.totalValue)))
  ).toFixed(2);
  const totalSaleValue = (
    parseFloat(money.sum(simpleRows.map((r) => r.stockValueAtSale))) +
    parseFloat(money.sum(variantRows.map((r) => r.totalValueAtSale)))
  ).toFixed(2);
  const lowStockCount = simpleRows.filter((r) => r.isLowStock).length;

  return {
    simpleItems: simpleRows.map((r) => ({
      itemName: r.itemName, category: r.category, hsn: r.hsn, unit: r.unit,
      currentStock: r.currentStock, stockValue: r.stockValue, stockValueAtSale: r.stockValueAtSale,
      isLowStock: r.isLowStock,
    })),
    variantItems: variantRows.map((r) => ({
      itemName: r.itemName, category: r.category, unit: r.unit,
      totalStock: r.totalStock, totalValue: r.totalValue, totalValueAtSale: r.totalValueAtSale,
    })),
    summary: { totalCostValue, totalSaleValue, totalSkuCount: simpleRows.length + variantRows.length, lowStockCount },
  };
}

async function loadGeneralLedger(db: Db, businessId: string, accountId: string, fromDate: string, toDate: string) {
  const [account] = await db.select()
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, accountId), eq(chartOfAccounts.businessId, businessId)))
    .limit(1);
  if (!account) return null;

  const from = new Date(fromDate);
  const to = new Date(toDate);
  const allDerived = await deriveLedger(db, businessId, from, to);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines: any[] = [];
  for (const entry of allDerived) {
    for (const line of entry.lines) {
      if (line.accountId === accountId) {
        lines.push({ date: entry.date, narration: entry.narration, sourceNumber: entry.sourceNumber, debit: line.debit, credit: line.credit });
      }
    }
  }
  lines.sort((a, b) => a.date.getTime() - b.date.getTime());

  let runningBalance = "0.00";
  const entries = lines.map((line) => {
    runningBalance = money.sub(money.add(runningBalance, line.debit), line.credit);
    return { date: line.date.toISOString(), narration: line.narration, sourceNumber: line.sourceNumber, debit: line.debit, credit: line.credit, balance: runningBalance };
  });

  return {
    accountCode: account.code,
    accountName: account.name,
    entries,
    closingBalance: runningBalance,
  };
}

/**
 * Load the GST tax summary breakdown (mirrors reports.taxSummary).
 */
async function loadTaxSummary(db: Db, businessId: string, fromDate: string, toDate: string, type?: string) {
  const typeCondition = type === "sales"
    ? sql`${invoices.type} = 'sale'`
    : type === "purchases"
      ? sql`${invoices.type} = 'purchase'`
      : sql`${invoices.type} IN ('sale', 'purchase')`;

  const rows = await db.select({
    invoiceType: invoices.type,
    taxPercent: invoiceItems.taxPercent,
    invoiceCount: sql<number>`COUNT(DISTINCT ${invoices.id})::int`,
    taxableAmount: sql<string>`SUM(${invoiceItems.totalAmount}::numeric - ${invoiceItems.taxAmount}::numeric)::text`,
    taxAmount: sql<string>`SUM(${invoiceItems.taxAmount}::numeric)::text`,
    grossAmount: sql<string>`SUM(${invoiceItems.totalAmount}::numeric)::text`,
  })
    .from(invoiceItems).innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
    .where(and(
      eq(invoices.businessId, businessId),
      eq(invoices.documentType, "invoice"),
      sql`${invoices.status} NOT IN ('draft', 'cancelled')`,
      isNull(invoices.deletedAt),
      ...buildBusinessDateFilter(invoices, { from: fromDate, to: toDate }),
      typeCondition,
    ))
    .groupBy(invoices.type, invoiceItems.taxPercent)
    .orderBy(invoices.type, invoiceItems.taxPercent);

  const salesBreakdown = rows.filter((r) => r.invoiceType === "sale");
  const purchaseBreakdown = rows.filter((r) => r.invoiceType === "purchase");

  return {
    salesBreakdown,
    purchaseBreakdown,
    summary: {
      totalTaxCollected: money.sum(salesBreakdown.map((r) => r.taxAmount)),
      totalTaxPaid: money.sum(purchaseBreakdown.map((r) => r.taxAmount)),
      netTaxLiability: money.sub(
        money.sum(salesBreakdown.map((r) => r.taxAmount)),
        money.sum(purchaseBreakdown.map((r) => r.taxAmount)),
      ),
    },
  };
}

// ── Extended operational loader: payment summary (mirrors reports router) ──

async function loadPaymentSummary(
  db: Db,
  businessId: string,
  fromDate: string,
  toDate: string,
  type?: string,
  bankAccountId?: string,
) {
  const from = new Date(fromDate);
  const to = new Date(toDate);

  const paymentConditions = [
    eq(payments.businessId, businessId),
    isNull(payments.deletedAt),
    ...buildBusinessDateFilter(payments, { from, to }),
  ];
  if (bankAccountId) paymentConditions.push(eq(payments.bankAccountId, bankAccountId));

  const receivedCondition =
    type === "received"
      ? [eq(parties.type, "customer")]
      : type === "made"
        ? [eq(parties.type, "supplier")]
        : [];

  const [paymentModeRows, expenseRows, recentPayments] = await Promise.all([
    db.select({
      mode: payments.mode,
      bankAccountId: payments.bankAccountId,
      bankAccountName: bankAccounts.accountName,
      count: sql<number>`COUNT(*)::int`,
      totalAmount: sql<string>`SUM(${payments.amount}::numeric)::text`,
      customerPayments: sql<string>`SUM(CASE WHEN ${parties.type} = 'customer' THEN ${payments.amount}::numeric ELSE 0 END)::text`,
      supplierPayments: sql<string>`SUM(CASE WHEN ${parties.type} = 'supplier' THEN ${payments.amount}::numeric ELSE 0 END)::text`,
    })
      .from(payments)
      .innerJoin(parties, eq(parties.id, payments.partyId))
      .leftJoin(bankAccounts, eq(bankAccounts.id, payments.bankAccountId))
      .where(and(...paymentConditions, ...receivedCondition))
      .groupBy(payments.mode, payments.bankAccountId, bankAccounts.accountName)
      .orderBy(sql`SUM(${payments.amount}::numeric) DESC`),

    type !== "received"
      ? db.select({
          mode: expenses.mode,
          count: sql<number>`COUNT(*)::int`,
          totalAmount: sql<string>`SUM(${expenses.amount}::numeric)::text`,
        })
        .from(expenses)
        .where(and(
          eq(expenses.businessId, businessId),
          isNull(expenses.deletedAt),
          ...buildBusinessDateFilter(expenses, { from, to }),
        ))
        .groupBy(expenses.mode)
      : [],

    db.select({
      id: payments.id,
      paymentNumber: payments.paymentNumber,
      date: payments.paymentDate,
      partyName: parties.name,
      partyType: parties.type,
      amount: payments.amount,
      mode: payments.mode,
    })
      .from(payments)
      .innerJoin(parties, eq(parties.id, payments.partyId))
      .where(and(...paymentConditions, ...receivedCondition))
      .orderBy(desc(payments.paymentDate))
      .limit(200),
  ]);

  const totalReceived = money.sum(paymentModeRows.map((r) => r.customerPayments));
  const totalMade = money.sum(paymentModeRows.map((r) => r.supplierPayments));
  const totalExpenses = money.sum(expenseRows.map((r) => r.totalAmount));

  return {
    byMode: paymentModeRows,
    expenses: expenseRows,
    recentPayments,
    totalReceived,
    totalMade,
    totalExpenses,
    netCashMovement: money.sub(totalReceived, money.add(totalMade, totalExpenses)),
  };
}

// ── Extended operational loader: item-wise sales ─────────────────────────

async function loadItemSales(
  db: Db,
  businessId: string,
  fromDate: string,
  toDate: string,
  category?: string,
) {
  const conditions = [
    eq(invoices.businessId, businessId),
    eq(invoices.type, "sale"),
    eq(invoices.documentType, "invoice"),
    sql`${invoices.status} NOT IN ('draft', 'cancelled')`,
    isNull(invoices.deletedAt),
    ...buildBusinessDateFilter(invoices, { from: fromDate, to: toDate }),
    ...(category ? [eq(items.category, category)] : []),
  ];

  const rows = await db.select({
    itemId: invoiceItems.itemId,
    itemName: sql<string>`COALESCE(${items.name}, ${invoiceItems.itemName})`,
    category: items.category,
    unit: items.unit,
    soldQty: sql<string>`SUM(${invoiceItems.quantity}::numeric * COALESCE(${invoiceItems.conversionFactor}::numeric, 1))::text`,
    totalRevenue: sql<string>`SUM(${invoiceItems.totalAmount}::numeric)::text`,
    avgUnitPrice: sql<string>`ROUND(SUM(${invoiceItems.totalAmount}::numeric) / NULLIF(SUM(${invoiceItems.quantity}::numeric * COALESCE(${invoiceItems.conversionFactor}::numeric, 1)), 0), 2)::text`,
    invoiceCount: sql<number>`COUNT(DISTINCT ${invoices.id})::int`,
    uniqueCustomers: sql<number>`COUNT(DISTINCT ${invoices.partyId})::int`,
  })
    .from(invoiceItems)
    .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
    .leftJoin(items, eq(items.id, invoiceItems.itemId))
    .where(and(...conditions))
    .groupBy(invoiceItems.itemId, items.name, items.category, items.unit, invoiceItems.itemName)
    .orderBy(sql`SUM(${invoiceItems.totalAmount}::numeric) DESC`);

  return {
    rows,
    totalRevenue: money.sum(rows.map((r) => r.totalRevenue)),
    count: rows.length,
  };
}

/**
 * Build a report PDF buffer for the given type.
 *
 * @returns `null` when a required resource (e.g. the general-ledger account)
 * does not exist in this business; otherwise a buffer + filename bundle.
 */
export async function buildReportPdf(
  db: Db,
  businessId: string,
  type: ReportPdfType,
  filters: ReportPdfFilters = {},
): Promise<ReportPdfBundle | null> {
  const businessName = await getBusinessName(db, businessId);

  switch (type) {
    case "trial-balance": {
      const asOfDate = filters.asOfDate ?? new Date().toISOString();
      const data = await loadTrialBalance(db, businessId, asOfDate);
      const pdfBuffer = await generateTrialBalancePDF({ businessName, asOfDate, ...data });
      return { pdfBuffer, fileName: "trial-balance.pdf", businessName };
    }
    case "profit-loss": {
      const toDate = filters.toDate ?? new Date().toISOString();
      const fromDate = filters.fromDate ?? new Date(new Date(toDate).getFullYear(), 3, 1).toISOString();
      const data = await loadProfitAndLoss(db, businessId, fromDate, toDate);
      const pdfBuffer = await generateProfitAndLossPDF({ businessName, fromDate, toDate, ...data });
      return { pdfBuffer, fileName: "profit-and-loss.pdf", businessName };
    }
    case "balance-sheet": {
      const asOfDate = filters.asOfDate ?? new Date().toISOString();
      const data = await loadBalanceSheet(db, businessId, asOfDate);
      const pdfBuffer = await generateBalanceSheetPDF({ businessName, asOfDate, ...data });
      return { pdfBuffer, fileName: "balance-sheet.pdf", businessName };
    }
    case "daybook": {
      const toDate = filters.toDate ?? new Date().toISOString();
      const fromDate = filters.fromDate ?? new Date(new Date(toDate).getFullYear(), 3, 1).toISOString();
      const data = await loadDaybook(db, businessId, fromDate, toDate, filters.type);
      const pdfBuffer = await generateDaybookPDF({ businessName, fromDate, toDate, ...data });
      return { pdfBuffer, fileName: "daybook.pdf", businessName };
    }
    case "sales-register":
    case "purchase-register": {
      const toDate = filters.toDate ?? new Date().toISOString();
      const fromDate = filters.fromDate ?? new Date(new Date(toDate).getFullYear(), 3, 1).toISOString();
      const isSale = type === "sales-register";
      const data = await loadRegister(db, businessId, isSale ? "sale" : "purchase", fromDate, toDate, filters.partyId);
      const pdfBuffer = await generateRegisterPDF({
        businessName,
        title: isSale ? "Sales Register" : "Purchase Register",
        fromDate,
        toDate,
        ...data,
      });
      return { pdfBuffer, fileName: isSale ? "sales-register.pdf" : "purchase-register.pdf", businessName };
    }
    case "outstanding": {
      const asOfDate = filters.asOfDate ?? new Date().toISOString();
      const data = await loadOutstanding(db, businessId, asOfDate, filters.type);
      const pdfBuffer = await generateOutstandingPDF({ businessName, asOfDate, title: "Outstanding Report", ...data });
      return { pdfBuffer, fileName: "outstanding-report.pdf", businessName };
    }
    case "stock-summary": {
      const data = await loadStockSummary(db, businessId, filters.showZeroStock ?? false, filters.category);
      const pdfBuffer = await generateStockSummaryPDF({ businessName, asOfDate: new Date().toISOString(), ...data });
      return { pdfBuffer, fileName: "stock-summary.pdf", businessName };
    }
    case "general-ledger": {
      if (!filters.accountId) return null;
      const toDate = filters.toDate ?? new Date().toISOString();
      const fromDate = filters.fromDate ?? new Date(new Date(toDate).getFullYear(), 3, 1).toISOString();
      const data = await loadGeneralLedger(db, businessId, filters.accountId, fromDate, toDate);
      if (!data) return null;
      const pdfBuffer = await generateGeneralLedgerPDF({ businessName, fromDate, toDate, ...data });
      return { pdfBuffer, fileName: `ledger-${data.accountCode}.pdf`, businessName };
    }
    case "tax-summary": {
      const toDate = filters.toDate ?? new Date().toISOString();
      const fromDate = filters.fromDate ?? new Date(new Date(toDate).getFullYear(), 3, 1).toISOString();
      const data = await loadTaxSummary(db, businessId, fromDate, toDate, filters.type);
      const pdfBuffer = await generateTaxSummaryPDF({ businessName, fromDate, toDate, ...data });
      return { pdfBuffer, fileName: "tax-summary.pdf", businessName };
    }
    case "payment-summary": {
      const toDate = filters.toDate ?? new Date().toISOString();
      const fromDate = filters.fromDate ?? new Date(new Date(toDate).getFullYear(), 3, 1).toISOString();
      const data = await loadPaymentSummary(db, businessId, fromDate, toDate, filters.type, filters.bankAccountId);
      const pdfBuffer = await generatePaymentSummaryPDF({ businessName, fromDate, toDate, ...data });
      return { pdfBuffer, fileName: "payment-summary.pdf", businessName };
    }
    case "item-sales": {
      const toDate = filters.toDate ?? new Date().toISOString();
      const fromDate = filters.fromDate ?? new Date(new Date(toDate).getFullYear(), 3, 1).toISOString();
      const data = await loadItemSales(db, businessId, fromDate, toDate, filters.category);
      const pdfBuffer = await generateItemSalesPDF({
        businessName,
        fromDate,
        toDate,
        rows: data.rows.map((r) => ({
          itemName: r.itemName,
          category: r.category,
          unit: r.unit,
          soldQty: r.soldQty,
          totalRevenue: r.totalRevenue,
          avgUnitPrice: r.avgUnitPrice,
          invoiceCount: r.invoiceCount,
          uniqueCustomers: r.uniqueCustomers,
        })),
        totalRevenue: data.totalRevenue,
        count: data.count,
      });
      return { pdfBuffer, fileName: "item-sales.pdf", businessName };
    }
    case "collection-efficiency": {
      const toDate = filters.toDate ?? new Date().toISOString();
      const fromDate = filters.fromDate ?? new Date(new Date(toDate).getFullYear(), 3, 1).toISOString();
      const data = await loadCollectionEfficiency(db, businessId, fromDate, toDate);
      const pdfBuffer = await generateCollectionEfficiencyPDF({ businessName, fromDate, toDate, ...data });
      return { pdfBuffer, fileName: "collection-efficiency.pdf", businessName };
    }
    case "cash-flow": {
      const toDate = filters.toDate ?? new Date().toISOString();
      const fromDate = filters.fromDate ?? new Date(new Date(toDate).getFullYear(), 3, 1).toISOString();
      const data = await loadCashFlow(db, businessId, fromDate, toDate);
      const pdfBuffer = await generateCashFlowPDF({ businessName, fromDate, toDate, ...data });
      return { pdfBuffer, fileName: "cash-flow.pdf", businessName };
    }
    case "gstr1": {
      const year = filters.year ?? new Date().getFullYear();
      const month = filters.month ?? new Date().getMonth() + 1;
      const report = await generateGSTR1(businessId, year, month, db);
      const pdfBuffer = await generateGSTR1PDF(report);
      return { pdfBuffer, fileName: `GSTR1_${report.period.replace(" ", "_")}.pdf`, businessName };
    }
    case "gstr3b": {
      const year = filters.year ?? new Date().getFullYear();
      const month = filters.month ?? new Date().getMonth() + 1;
      const report = await generateGSTR3B(businessId, year, month, db);
      const pdfBuffer = await generateGSTR3BPDF(report);
      return { pdfBuffer, fileName: `GSTR3B_${report.period.replace(" ", "_")}.pdf`, businessName };
    }
    default:
      return null;
  }
}


// ── Extended operational loader: collection efficiency ───────────────────

async function loadCollectionEfficiency(db: Db, businessId: string, fromDate: string, toDate: string) {
  const periodStart = new Date(fromDate);
  const periodEnd = new Date(toDate);
  const daysInPeriod = Math.max(1, Math.round((periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24)));

  const [efficiencyResult, dsoResult] = await Promise.all([
    db.execute(sql`
      WITH paid_invoices AS (
        SELECT
          i.id,
          i.due_date,
          i.total_amount::numeric AS total,
          i.amount_paid::numeric AS paid,
          MAX(p.payment_date) AS last_payment_date
        FROM invoices i
        LEFT JOIN payments p ON p.invoice_id = i.id
          AND p.business_id = ${businessId}
        WHERE i.business_id = ${businessId}
          AND i.type = 'sale'
          AND i.document_type = 'invoice'
          AND i.status = 'paid'
          AND i.due_date IS NOT NULL
          AND i.invoice_date >= ${periodStart.toISOString()}::timestamptz
          AND i.invoice_date <= ${periodEnd.toISOString()}::timestamptz
          AND i.deleted_at IS NULL
        GROUP BY i.id, i.due_date, i.total_amount, i.amount_paid
      )
      SELECT
        COUNT(*) AS total_invoices,
        COUNT(*) FILTER (WHERE last_payment_date <= due_date) AS paid_on_time,
        COUNT(*) FILTER (WHERE last_payment_date > due_date) AS paid_late,
        ROUND(
          COUNT(*) FILTER (WHERE last_payment_date <= due_date)::numeric
            / NULLIF(COUNT(*), 0) * 100,
          1
        ) AS on_time_rate
      FROM paid_invoices
    `),

    db.execute(sql`
      WITH period_sales AS (
        SELECT
          SUM(total_amount::numeric) AS total_sales,
          AVG(total_amount::numeric - amount_paid::numeric) AS avg_receivable
        FROM invoices
        WHERE business_id = ${businessId}
          AND type = 'sale'
          AND document_type = 'invoice'
          AND status NOT IN ('draft', 'cancelled')
          AND invoice_date >= ${periodStart.toISOString()}::timestamptz
          AND invoice_date <= ${periodEnd.toISOString()}::timestamptz
          AND deleted_at IS NULL
      )
      SELECT
        ROUND(
          avg_receivable / NULLIF(total_sales, 0) * ${daysInPeriod}::numeric,
          1
        ) AS dso_days,
        total_sales::text AS total_sales,
        COALESCE(avg_receivable, 0)::text AS avg_receivable
      FROM period_sales
    `),
  ]);

  const eff = (efficiencyResult as unknown as Array<{
    total_invoices: string;
    paid_on_time: string;
    paid_late: string;
    on_time_rate: string | null;
  }>)[0];

  const dso = (dsoResult as unknown as Array<{
    dso_days: string | null;
    total_sales: string;
    avg_receivable: string;
  }>)[0];

  return {
    collectionEfficiency: {
      totalInvoices: parseInt(eff?.total_invoices ?? "0", 10),
      paidOnTime: parseInt(eff?.paid_on_time ?? "0", 10),
      paidLate: parseInt(eff?.paid_late ?? "0", 10),
      onTimeRate: eff?.on_time_rate ?? "0",
    },
    dso: {
      dsoDays: dso?.dso_days ?? null,
      totalSales: dso?.total_sales ?? "0",
      avgReceivable: dso?.avg_receivable ?? "0",
      daysInPeriod,
    },
  };
}


// ── Extended operational loader: cash flow statement ─────────────────────

async function loadCashFlow(db: Db, businessId: string, fromDate: string, toDate: string) {
  const from = new Date(fromDate);
  const to = new Date(toDate);

  const entries = await deriveFullLedger(db, businessId, from, to);

  const coaRows = await db
    .select({ code: chartOfAccounts.code, name: chartOfAccounts.name, accountType: chartOfAccounts.accountType })
    .from(chartOfAccounts).where(eq(chartOfAccounts.businessId, businessId));
  const coaTypeMap = new Map(coaRows.map((r: { code: string; name: string; accountType: string }) => [r.code, { name: r.name, type: r.accountType }]));

  const movMap = new Map<string, { name: string; debit: string; credit: string }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const existing = movMap.get(line.accountCode) ?? { name: line.accountName, debit: "0.00", credit: "0.00" };
      existing.debit = money.add(existing.debit, line.debit);
      existing.credit = money.add(existing.credit, line.credit);
      movMap.set(line.accountCode, existing);
    }
  }

  function netDebit(code: string): string {
    const acc = movMap.get(code);
    if (!acc) return "0.00";
    return money.sub(acc.debit, acc.credit);
  }

  function netCredit(code: string): string {
    const acc = movMap.get(code);
    if (!acc) return "0.00";
    return money.sub(acc.credit, acc.debit);
  }

  let totalIncomeCredits = "0.00";
  let totalIncomeDebits = "0.00";
  let totalExpenseDebits = "0.00";
  let totalExpenseCredits = "0.00";
  for (const [code, acc] of movMap) {
    const acctInfo = coaTypeMap.get(code);
    if (!acctInfo) continue;
    if (acctInfo.type === "income") {
      totalIncomeCredits = money.add(totalIncomeCredits, acc.credit);
      totalIncomeDebits = money.add(totalIncomeDebits, acc.debit);
    } else if (acctInfo.type === "expense") {
      totalExpenseDebits = money.add(totalExpenseDebits, acc.debit);
      totalExpenseCredits = money.add(totalExpenseCredits, acc.credit);
    }
  }
  const netIncome = money.sub(
    money.sub(totalIncomeCredits, totalIncomeDebits),
    money.sub(totalExpenseDebits, totalExpenseCredits),
  );

  const adjustments: Array<{ description: string; amount: string }> = [];
  const depreciationAmt = netDebit("5900");
  if (!money.isZero(depreciationAmt)) {
    adjustments.push({ description: "Depreciation (non-cash expense)", amount: depreciationAmt });
  }

  const workingCapitalChanges: Array<{ description: string; amount: string }> = [];
  const recvChange = netDebit("1100");
  if (!money.isZero(recvChange)) {
    workingCapitalChanges.push({ description: "Change in Accounts Receivable", amount: money.sub("0.00", recvChange) });
  }
  const payChange = netCredit("2000");
  if (!money.isZero(payChange)) {
    workingCapitalChanges.push({ description: "Change in Accounts Payable", amount: payChange });
  }

  const totalOperating = money.sum([netIncome, ...adjustments.map((a) => a.amount), ...workingCapitalChanges.map((w) => w.amount)]);

  const investingItems: Array<{ description: string; amount: string }> = [];
  const EXCLUDED_ASSET_CODES = new Set(["1000", "1010", "1100", "1200", "1510", "1511", "1512"]);
  for (const [code, acc] of movMap) {
    if (!code.startsWith("1") || EXCLUDED_ASSET_CODES.has(code)) continue;
    const acctInfo = coaTypeMap.get(code);
    if (!acctInfo || acctInfo.type !== "asset") continue;
    const net = netDebit(code);
    if (!money.isZero(net)) {
      investingItems.push({
        description: money.compare(net, "0") > 0 ? `Purchase of ${acc.name}` : `Proceeds from ${acc.name}`,
        amount: money.sub("0.00", net),
      });
    }
  }
  const totalInvesting = money.sum(investingItems.map((i) => i.amount));

  const financingItems: Array<{ description: string; amount: string }> = [];
  const capitalChange = netCredit("3000");
  if (!money.isZero(capitalChange)) {
    financingItems.push({
      description: money.compare(capitalChange, "0") > 0 ? "Capital Contributed" : "Capital Withdrawn",
      amount: capitalChange,
    });
  }
  const drawingsChange = netDebit("3100");
  if (!money.isZero(drawingsChange)) {
    financingItems.push({ description: "Owner Drawings", amount: money.sub("0.00", drawingsChange) });
  }
  const EXCLUDED_LIABILITY_CODES = new Set(["2000", "2100", "2101", "2102"]);
  for (const [code, acc] of movMap) {
    if (!code.startsWith("2") || EXCLUDED_LIABILITY_CODES.has(code)) continue;
    const acctInfo = coaTypeMap.get(code);
    if (!acctInfo || acctInfo.type !== "liability") continue;
    const net = netCredit(code);
    if (!money.isZero(net)) {
      financingItems.push({
        description: money.compare(net, "0") > 0 ? `Proceeds from ${acc.name}` : `Repayment of ${acc.name}`,
        amount: net,
      });
    }
  }
  const totalFinancing = money.sum(financingItems.map((f) => f.amount));

  const netCashFlow = money.sum([totalOperating, totalInvesting, totalFinancing]);

  const openingEntries = await deriveFullLedger(db, businessId, new Date("2000-01-01"), new Date(from.getTime() - 1));
  let openingCash = "0.00";
  for (const entry of openingEntries) {
    for (const line of entry.lines) {
      if (line.accountCode === "1000" || line.accountCode === "1010") {
        openingCash = money.add(openingCash, money.sub(line.debit, line.credit));
      }
    }
  }
  const closingCashBalance = money.add(openingCash, netCashFlow);

  return {
    operating: { netIncome, adjustments, workingCapitalChanges, totalOperating },
    investing: { items: investingItems, totalInvesting },
    financing: { items: financingItems, totalFinancing },
    netCashFlow,
    openingCashBalance: openingCash,
    closingCashBalance,
  };
}


