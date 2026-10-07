/**
 * caHandover.ts — One-click year-end CA handover pack.
 *
 * Aggregates all GST returns, ITC statements, financial statements, and
 * accounting registers into a single response that the frontend zips into
 * a downloadable pack for the chartered accountant.
 *
 * Each section is generated independently inside its own try/catch so that
 * a single failing section (e.g. trial balance errors on a business without
 * a chart of accounts) does not block the rest of the pack. Failures are
 * collected into the `errors` map keyed by section name.
 */

import { z } from "zod";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  invoices,
  invoiceItems,
  parties,
  itcLedgerEntries,
  items as itemsTable,
  chartOfAccounts,
} from "@hisaabo/db";
import type { TenantDatabase } from "@hisaabo/db";
import { deriveFullLedger } from "../lib/derive-ledger.js";
import { buildBusinessDateFilter } from "../lib/business-date.js";
import { generateGSTR1, generateGSTR3B } from "../lib/gst-reports.js";
import { generateGSTR9 } from "../lib/gstr9-generator.js";
import { router, viewerProcedure } from "../trpc.js";
import { requireCan } from "../lib/permissions.js";
import { money } from "@hisaabo/shared";

// ── Helpers ──────────────────────────────────────────────────────

/** Build 12 months of an Indian financial year (April → March). */
function fyMonths(fy: number): Array<{ year: number; month: number }> {
  const months: Array<{ year: number; month: number }> = [];
  for (let m = 4; m <= 12; m++) months.push({ year: fy, month: m });
  for (let m = 1; m <= 3; m++) months.push({ year: fy + 1, month: m });
  return months;
}

/** FY dates: April 1 of start year → March 31 of end year. */
function fyDates(fy: number): { from: Date; to: Date } {
  return {
    from: new Date(fy, 3, 1),
    to: new Date(fy + 1, 2, 31, 23, 59, 59, 999),
  };
}

const ZERO = "0.00";

// ── Section generators ───────────────────────────────────────────

async function buildGstr1Annual(
  businessId: string,
  financialYear: number,
  db: TenantDatabase,
) {
  const months = fyMonths(financialYear);
  const reports = await Promise.all(
    months.map(({ year, month }) => generateGSTR1(businessId, year, month, db)),
  );

  const totals = reports.reduce(
    (acc, r) => ({
      invoiceCount: acc.invoiceCount + r.invoiceCount,
      taxableValue: acc.taxableValue + r.totalTaxableValue,
      cgst: acc.cgst + r.totalCgst,
      sgst: acc.sgst + r.totalSgst,
      igst: acc.igst + r.totalIgst,
      totalTax: acc.totalTax + r.totalTax,
      totalInvoiceValue: acc.totalInvoiceValue + r.totalInvoiceValue,
    }),
    { invoiceCount: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0, totalInvoiceValue: 0 },
  );

  const monthlyBreakdown = reports.map((r, i) => ({
    period: `${months[i]!.year}-${String(months[i]!.month).padStart(2, "0")}`,
    invoiceCount: r.invoiceCount,
    taxableValue: r.totalTaxableValue,
    cgst: r.totalCgst,
    sgst: r.totalSgst,
    igst: r.totalIgst,
    totalTax: r.totalTax,
    empty: r.invoiceCount === 0,
  }));

  const b2bMap = new Map<string, {
    partyGstin: string; partyName: string; invoiceCount: number;
    taxableValue: number; cgst: number; sgst: number; igst: number;
  }>();
  for (const r of reports) {
    for (const b of r.b2b) {
      const e = b2bMap.get(b.partyGstin) ?? {
        partyGstin: b.partyGstin, partyName: b.partyName, invoiceCount: 0,
        taxableValue: 0, cgst: 0, sgst: 0, igst: 0,
      };
      e.invoiceCount += 1;
      e.taxableValue += b.taxableValue;
      e.cgst += b.cgst;
      e.sgst += b.sgst;
      e.igst += b.igst;
      b2bMap.set(b.partyGstin, e);
    }
  }

  const b2cMap = new Map<number, { taxRate: number; taxableValue: number; cgst: number; sgst: number; igst: number }>();
  for (const r of reports) {
    for (const b of r.b2cSmall) {
      const e = b2cMap.get(b.taxRate) ?? { taxRate: b.taxRate, taxableValue: 0, cgst: 0, sgst: 0, igst: 0 };
      e.taxableValue += b.taxableValue;
      e.cgst += b.cgst;
      e.sgst += b.sgst;
      e.igst += b.igst;
      b2cMap.set(b.taxRate, e);
    }
  }

  const hsnMap = new Map<string, {
    hsn: string; description: string; quantity: number;
    taxableValue: number; cgst: number; sgst: number; igst: number; totalValue: number;
  }>();
  for (const r of reports) {
    for (const h of r.hsn) {
      const e = hsnMap.get(h.hsn) ?? {
        hsn: h.hsn, description: h.description, quantity: 0,
        taxableValue: 0, cgst: 0, sgst: 0, igst: 0, totalValue: 0,
      };
      e.quantity += h.quantity;
      e.taxableValue += h.taxableValue;
      e.totalValue += h.totalValue;
      e.cgst += h.cgst;
      e.sgst += h.sgst;
      e.igst += h.igst;
      hsnMap.set(h.hsn, e);
    }
  }

  return {
    financialYear,
    totals,
    monthlyBreakdown,
    b2b: [...b2bMap.values()],
    b2cSmall: [...b2cMap.values()].sort((a, b) => a.taxRate - b.taxRate),
    hsn: [...hsnMap.values()],
  };
}

async function buildGstr3bAnnual(
  businessId: string,
  financialYear: number,
  db: TenantDatabase,
) {
  const months = fyMonths(financialYear);
  const reports = await Promise.all(
    months.map(({ year, month }) => generateGSTR3B(businessId, year, month, db)),
  );

  const outwardSupplies = {
    taxable: reports.reduce(
      (acc, r) => ({
        taxableValue: acc.taxableValue + r.outwardSupplies.taxable.taxableValue,
        igst: acc.igst + r.outwardSupplies.taxable.igst,
        cgst: acc.cgst + r.outwardSupplies.taxable.cgst,
        sgst: acc.sgst + r.outwardSupplies.taxable.sgst,
      }),
      { taxableValue: 0, igst: 0, cgst: 0, sgst: 0 },
    ),
    zeroRated: { taxableValue: 0, igst: 0, cgst: 0, sgst: 0 },
    exempt: { taxableValue: 0, igst: 0, cgst: 0, sgst: 0 },
  };

  const itc = reports.reduce(
    (acc, r) => ({
      igst: acc.igst + r.itc.igst,
      cgst: acc.cgst + r.itc.cgst,
      sgst: acc.sgst + r.itc.sgst,
      total: acc.total + r.itc.total,
    }),
    { igst: 0, cgst: 0, sgst: 0, total: 0 },
  );

  const taxPayable = reports.reduce(
    (acc, r) => ({
      igst: acc.igst + r.taxPayable.igst,
      cgst: acc.cgst + r.taxPayable.cgst,
      sgst: acc.sgst + r.taxPayable.sgst,
    }),
    { igst: 0, cgst: 0, sgst: 0 },
  );

  const netTax = {
    igst: taxPayable.igst - itc.igst,
    cgst: taxPayable.cgst - itc.cgst,
    sgst: taxPayable.sgst - itc.sgst,
    total: taxPayable.igst + taxPayable.cgst + taxPayable.sgst - itc.total,
  };

  const monthlyBreakdown = reports.map((r, i) => ({
    period: `${months[i]!.year}-${String(months[i]!.month).padStart(2, "0")}`,
    outwardTaxable: r.outwardSupplies.taxable.taxableValue,
    igst: r.outwardSupplies.taxable.igst,
    cgst: r.outwardSupplies.taxable.cgst,
    sgst: r.outwardSupplies.taxable.sgst,
    itcTotal: r.itc.total,
    taxPayable: r.taxPayable,
  }));

  return { financialYear, outwardSupplies, itc, taxPayable, netTax, monthlyBreakdown };
}

async function buildItcAnnual(businessId: string, financialYear: number, db: TenantDatabase) {
  const periods: string[] = [];
  for (let m = 0; m < 12; m++) {
    const d = new Date(financialYear, 3 + m, 1);
    periods.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  async function sumItc(extra: SQL<unknown>[]) {
    const [row] = await db
      .select({
        cgst: sql<string>`COALESCE(SUM(${itcLedgerEntries.cgst}::numeric), 0)::text`,
        sgst: sql<string>`COALESCE(SUM(${itcLedgerEntries.sgst}::numeric), 0)::text`,
        igst: sql<string>`COALESCE(SUM(${itcLedgerEntries.igst}::numeric), 0)::text`,
        cess: sql<string>`COALESCE(SUM(${itcLedgerEntries.cess}::numeric), 0)::text`,
      })
      .from(itcLedgerEntries)
      .where(and(
        eq(itcLedgerEntries.businessId, businessId),
        inArray(itcLedgerEntries.returnPeriod, periods),
        ...extra,
      ));
    return {
      cgst: row?.cgst ?? ZERO,
      sgst: row?.sgst ?? ZERO,
      igst: row?.igst ?? ZERO,
      cess: row?.cess ?? ZERO,
    };
  }

  const toTaxRow = (r: { cgst: string; sgst: string; igst: string; cess: string }) => ({
    integratedTax: r.igst,
    centralTax: r.cgst,
    stateTax: r.sgst,
    cess: r.cess,
  });

  const row4A3 = await sumItc([
    eq(itcLedgerEntries.isReverseCharge, true),
    eq(itcLedgerEntries.status, "available"),
  ]);
  const row4A5 = await sumItc([
    eq(itcLedgerEntries.isReverseCharge, false),
    eq(itcLedgerEntries.status, "available"),
  ]);
  const row4B = await sumItc([sql`${itcLedgerEntries.status} IN ('blocked', 'reversed')`]);

  const zero = { cgst: ZERO, sgst: ZERO, igst: ZERO, cess: ZERO };

  const total4A = {
    integratedTax: money.sum([zero.igst, zero.igst, row4A3.igst, row4A5.igst]),
    centralTax: money.sum([zero.cgst, zero.cgst, row4A3.cgst, row4A5.cgst]),
    stateTax: money.sum([zero.sgst, zero.sgst, row4A3.sgst, row4A5.sgst]),
    cess: money.sum([zero.cess, zero.cess, row4A3.cess, row4A5.cess]),
  };

  const total4B = toTaxRow(row4B);

  const netItc = {
    integratedTax: money.sub(total4A.integratedTax, total4B.integratedTax),
    centralTax: money.sub(total4A.centralTax, total4B.centralTax),
    stateTax: money.sub(total4A.stateTax, total4B.stateTax),
    cess: money.sub(total4A.cess, total4B.cess),
  };

  return {
    financialYear,
    periods,
    itcAvailable: {
      importOfGoods: toTaxRow(zero),
      importOfServices: toTaxRow(zero),
      reverseCharge: toTaxRow(row4A3),
      allOther: toTaxRow(row4A5),
      total: total4A,
    },
    itcReversed: { total: total4B },
    netItc,
  };
}

async function buildTaxSummary(businessId: string, financialYear: number, db: TenantDatabase) {
  const { from, to } = fyDates(financialYear);

  const rows = await db
    .select({
      invoiceType: invoices.type,
      taxPercent: invoiceItems.taxPercent,
      invoiceCount: sql<number>`COUNT(DISTINCT ${invoices.id})::int`,
      taxableAmount: sql<string>`SUM(${invoiceItems.totalAmount}::numeric - ${invoiceItems.taxAmount}::numeric)::text`,
      taxAmount: sql<string>`SUM(${invoiceItems.taxAmount}::numeric)::text`,
      grossAmount: sql<string>`SUM(${invoiceItems.totalAmount}::numeric)::text`,
    })
    .from(invoiceItems)
    .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
    .where(
      and(
        eq(invoices.businessId, businessId),
        eq(invoices.documentType, "invoice"),
        sql`${invoices.status} NOT IN ('draft', 'cancelled')`,
        isNull(invoices.deletedAt),
        ...buildBusinessDateFilter(invoices, { from, to }),
        sql`${invoices.type} IN ('sale', 'purchase')`,
      ),
    )
    .groupBy(invoices.type, invoiceItems.taxPercent)
    .orderBy(invoices.type, invoiceItems.taxPercent);

  const salesRows = rows.filter((r) => r.invoiceType === "sale");
  const purchaseRows = rows.filter((r) => r.invoiceType === "purchase");

  return {
    salesBreakdown: salesRows,
    purchaseBreakdown: purchaseRows,
    summary: {
      totalTaxCollected: money.sum(salesRows.map((r) => r.taxAmount)),
      totalTaxPaid: money.sum(purchaseRows.map((r) => r.taxAmount)),
      netTaxLiability: money.sub(
        money.sum(salesRows.map((r) => r.taxAmount)),
        money.sum(purchaseRows.map((r) => r.taxAmount)),
      ),
    },
  };
}

async function buildStockSummary(businessId: string, db: TenantDatabase) {
  const simpleRows = await db
    .select({
      itemId: itemsTable.id,
      itemName: itemsTable.name,
      category: itemsTable.category,
      hsn: itemsTable.hsn,
      unit: itemsTable.unit,
      currentStock: itemsTable.stockQuantity,
      purchasePrice: itemsTable.purchasePrice,
      salePrice: itemsTable.salePrice,
      stockValue: sql<string>`ROUND(GREATEST(${itemsTable.stockQuantity}::numeric, 0) * COALESCE(${itemsTable.purchasePrice}::numeric, 0), 2)::text`,
      stockValueAtSale: sql<string>`ROUND(GREATEST(${itemsTable.stockQuantity}::numeric, 0) * COALESCE(${itemsTable.salePrice}::numeric, 0), 2)::text`,
      lowStockAlert: itemsTable.lowStockAlert,
    })
    .from(itemsTable)
    .where(and(
      eq(itemsTable.businessId, businessId),
      eq(itemsTable.itemType, "product"),
      sql`${itemsTable.itemMode} != 'variants'`,
      isNull(itemsTable.deletedAt),
    ))
    .orderBy(itemsTable.name);

  return { simple: simpleRows };
}

async function buildTrialBalance(businessId: string, from: Date, asOf: Date, db: TenantDatabase) {
  const entries = await deriveFullLedger(db, businessId, from, asOf);

  const accountMap = new Map<string, { debit: string; credit: string; name: string }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const existing = accountMap.get(line.accountCode) ?? {
        debit: "0.00", credit: "0.00", name: line.accountName,
      };
      existing.debit = money.add(existing.debit, line.debit);
      existing.credit = money.add(existing.credit, line.credit);
      accountMap.set(line.accountCode, existing);
    }
  }

  const coaRows = await db
    .select({
      code: chartOfAccounts.code,
      accountType: chartOfAccounts.accountType,
    })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.businessId, businessId));

  const coaTypeMap = new Map(coaRows.map((r) => [r.code, r.accountType]));

  const accounts = [...accountMap.entries()]
    .map(([code, a]) => ({
      accountCode: code,
      accountName: a.name,
      accountType: coaTypeMap.get(code) ?? "expense",
      debit: a.debit,
      credit: a.credit,
      balance: money.sub(a.debit, a.credit),
    }))
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  return {
    accounts,
    totalDebit: money.sum(accounts.map((a) => a.debit)),
    totalCredit: money.sum(accounts.map((a) => a.credit)),
  };
}

async function buildProfitAndLoss(businessId: string, from: Date, to: Date, db: TenantDatabase) {
  const entries = await deriveFullLedger(db, businessId, from, to);

  const coaRows = await db
    .select({
      code: chartOfAccounts.code,
      name: chartOfAccounts.name,
      accountType: chartOfAccounts.accountType,
    })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.businessId, businessId));

  const coaTypeMap = new Map(coaRows.map((r) => [r.code, { name: r.name, type: r.accountType }]));

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
  const expenses: Array<{ accountCode: string; accountName: string; amount: string }> = [];

  for (const [code, acctInfo] of coaTypeMap) {
    const acc = accountMap.get(code);
    if (acctInfo.type === "income") {
      income.push({ accountCode: code, accountName: acctInfo.name, amount: acc ? money.sub(acc.credit, acc.debit) : "0.00" });
    } else if (acctInfo.type === "expense") {
      expenses.push({ accountCode: code, accountName: acctInfo.name, amount: acc ? money.sub(acc.debit, acc.credit) : "0.00" });
    }
  }

  income.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  expenses.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  const totalIncome = money.sum(income.map((a) => a.amount));
  const totalExpenses = money.sum(expenses.map((a) => a.amount));

  return { income, expenses, totalIncome, totalExpenses, netProfit: money.sub(totalIncome, totalExpenses) };
}

async function buildBalanceSheet(businessId: string, from: Date, to: Date, db: TenantDatabase) {
  const entries = await deriveFullLedger(db, businessId, from, to);

  const coaRows = await db
    .select({
      code: chartOfAccounts.code,
      name: chartOfAccounts.name,
      accountType: chartOfAccounts.accountType,
    })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.businessId, businessId));

  const coaTypeMap = new Map(coaRows.map((r) => [r.code, { name: r.name, type: r.accountType }]));

  const allMap = new Map<string, { code: string; name: string; debit: string; credit: string }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const existing = allMap.get(line.accountCode) ?? {
        code: line.accountCode, name: line.accountName, debit: "0.00", credit: "0.00",
      };
      existing.debit = money.add(existing.debit, line.debit);
      existing.credit = money.add(existing.credit, line.credit);
      allMap.set(line.accountCode, existing);
    }
  }

  let totalIncomeCredits = "0.00";
  let totalIncomeDebits = "0.00";
  let totalExpenseDebits = "0.00";
  let totalExpenseCredits = "0.00";
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
    if (acctInfo.type !== "asset" && acctInfo.type !== "liability" && acctInfo.type !== "equity") continue;
    const acc = allMap.get(code);
    let balance: string;
    if (acctInfo.type === "asset") {
      balance = acc ? money.sub(acc.debit, acc.credit) : "0.00";
      assets.push({ accountCode: code, accountName: acctInfo.name, balance });
    } else if (acctInfo.type === "liability") {
      balance = acc ? money.sub(acc.credit, acc.debit) : "0.00";
      liabilities.push({ accountCode: code, accountName: acctInfo.name, balance });
    } else {
      balance = acc ? money.sub(acc.credit, acc.debit) : "0.00";
      equity.push({ accountCode: code, accountName: acctInfo.name, balance });
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

async function buildRegister(
  businessId: string,
  invoiceType: "sale" | "purchase",
  from: Date,
  to: Date,
  db: TenantDatabase,
) {
  const rows = await db
    .select({
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
    .from(invoices)
    .innerJoin(parties, eq(parties.id, invoices.partyId))
    .where(and(
      eq(invoices.businessId, businessId),
      eq(invoices.type, invoiceType),
      eq(invoices.documentType, "invoice"),
      sql`${invoices.status} != 'cancelled'`,
      isNull(invoices.deletedAt),
      ...buildBusinessDateFilter(invoices, { from, to }),
    ))
    .orderBy(invoices.invoiceDate);

  return {
    data: rows,
    summary: {
      totalSubtotal: money.sum(rows.map((r) => r.subtotal)),
      totalTax: money.sum(rows.map((r) => r.taxAmount)),
      totalAmount: money.sum(rows.map((r) => r.totalAmount)),
      count: rows.length,
    },
  };
}

// ── Router ───────────────────────────────────────────────────────

export const caHandoverRouter = router({
  pack: viewerProcedure
    .input(z.object({
      financialYear: z.number().int().min(2020).max(2099),
    }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "Report");

      const fy = input.financialYear;
      const { from, to } = fyDates(fy);
      const periodStart = from.toISOString();
      const periodEnd = to.toISOString();
      const generatedAt = new Date().toISOString();

      const sections: Record<string, unknown> = {};
      const errors: Record<string, string> = {};

      async function trySection(name: string, fn: () => Promise<unknown>) {
        try {
          sections[name] = await fn();
        } catch (e) {
          errors[name] = e instanceof Error ? e.message : String(e);
        }
      }

      await trySection("gstr1Annual", () => buildGstr1Annual(ctx.businessId, fy, ctx.db));
      await trySection("gstr3bAnnual", () => buildGstr3bAnnual(ctx.businessId, fy, ctx.db));
      await trySection("gstr9", () => generateGSTR9(ctx.businessId, fy, ctx.db));
      await trySection("itcAnnual", () => buildItcAnnual(ctx.businessId, fy, ctx.db));
      await trySection("taxSummary", () => buildTaxSummary(ctx.businessId, fy, ctx.db));
      await trySection("stockSummary", () => buildStockSummary(ctx.businessId, ctx.db));
      await trySection("trialBalance", () => buildTrialBalance(ctx.businessId, from, to, ctx.db));
      await trySection("profitAndLoss", () => buildProfitAndLoss(ctx.businessId, from, to, ctx.db));
      await trySection("balanceSheet", () => buildBalanceSheet(ctx.businessId, from, to, ctx.db));
      await trySection("salesRegister", () => buildRegister(ctx.businessId, "sale", from, to, ctx.db));
      await trySection("purchaseRegister", () => buildRegister(ctx.businessId, "purchase", from, to, ctx.db));

      return {
        financialYear: String(fy),
        generatedAt,
        period: { from: periodStart, to: periodEnd },
        sections,
        errors,
      };
    }),
});
