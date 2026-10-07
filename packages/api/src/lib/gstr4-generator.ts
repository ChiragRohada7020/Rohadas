/**
 * gstr4-generator.ts — Quarterly GSTR-4 return for composition-scheme dealers.
 *
 * GSTR-4 is filed by businesses registered under the composition levy scheme.
 * Under this scheme:
 *   - Outward supplies carry 0% GST (the dealer does not collect tax from customers);
 *   - The dealer pays a flat rate on turnover (1%, 0.5%, 5%, or 6% depending on category);
 *   - The dealer cannot avail Input Tax Credit (ITC), so all purchase-tax is reversed.
 *
 * This module aggregates the dealer's sale invoices (for turnover) and purchase
 * invoices (for ITC-to-be-reversed) for a single quarter and produces the structured
 * report data expected by the GSTR4View frontend component.
 *
 * Money: all numeric values are integers in paise (the smallest unit of INR).
 * This avoids floating-point accumulation errors, following the pattern established
 * in `packages/shared/src/money.ts`.
 */

import type { TenantDatabase } from "@hisaabo/db";
import { invoices, businesses, parties } from "@hisaabo/db";
import { and, eq, sql } from "drizzle-orm";
import { isNull } from "drizzle-orm";
import { buildBusinessDateFilter } from "./business-date.js";

// ── Types ──────────────────────────────────────────────────────

/** A single tax-split row used in several GSTR-4 tables. Values are in paise. */
export interface TaxRow {
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
}

/** Table 4 — Details of advances received and inward supplies */
export interface GSTR4Table4 {
  inwardExempt: TaxRow;
  inwardNonExempt: TaxRow;
  ownExempt: TaxRow;
  ownNonExempt: TaxRow;
  inwardReverseCharge: TaxRow;
  inwardIsd: TaxRow;
  otherItc: TaxRow;
  refund: TaxRow;
}

/** Table 5 — Details of input tax credit reversed */
export interface GSTR4Table5 {
  rule42_43: TaxRow;
  section17_5: TaxRow;
  others: TaxRow;
  total: TaxRow;
}

/** Table 6 — Details of tax paid */
export interface GSTR4Table6 {
  taxPayableOnTurnover: number;
  taxPaidViaItc: number;
  taxPaidViaCash: number;
  excessItcUtilised: number;
}

/** Top-level GSTR-4 Report */
export interface GSTR4Report {
  businessName: string;
  businessGstin: string;
  period: string;
  quarter: number;
  year: number;
  turnover: number;
  compositionRate: number;
  table4: GSTR4Table4;
  table5: GSTR4Table5;
  table6: GSTR4Table6;
  taxPayable: number;
}

// ── Helpers ────────────────────────────────────────────────────

function zeroRow(): TaxRow {
  return { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
}

/** Sum tax amounts from numeric strings into paise integers. */
function toPaise(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const num = typeof value === "string" ? parseFloat(value) : value;
  return isNaN(num) ? 0 : Math.round(num * 100);
}

/** Split a paise amount exactly in half — odd paise goes to CGST (per GST rounding rules). */
function splitPaise(paise: number): [number, number] {
  const half = Math.floor(paise / 2);
  return [half, paise - half];
}

// ── Quarter date helpers ───────────────────────────────────────

const QUARTER_START_MONTH = { 1: 0, 2: 3, 3: 6, 4: 9 } as const;

function quarterDateRange(year: number, quarter: number): { start: Date; end: Date } {
  const startMonth = QUARTER_START_MONTH[quarter as 1 | 2 | 3 | 4] ?? 0;
  const startDate = new Date(year, startMonth, 1);
  const endDate = new Date(year, startMonth + 3, 0, 23, 59, 59, 999);
  return { start: startDate, end: endDate };
}

// ── Generator ──────────────────────────────────────────────────

/**
 * Generate the full GSTR-4 quarterly return for a composition-scheme dealer.
 *
 * @param ctx  - tRPC context (must include businessId and db)
 * @param year - Calendar year of the quarter (e.g. 2025)
 * @param quarter - Quarter number 1-4
 * @param compositionRate - Composition rate in percent (e.g. 1, 0.5, 5, 6)
 */
export async function buildGSTR4(
  ctx: { businessId: string; db: TenantDatabase },
  year: number,
  quarter: number,
  compositionRate: number,
): Promise<GSTR4Report> {
  const { start: quarterStart, end: quarterEnd } = quarterDateRange(year, quarter);

  // Fetch business info
  const [biz] = await ctx.db
    .select({ name: businesses.name, gstin: businesses.gstin, stateCode: businesses.stateCode, state: businesses.state })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId))
    .limit(1);

  // ── Fetch sale invoices for the quarter (turnover) ──────────
  const saleRows = await ctx.db
    .select({
      subtotal: invoices.subtotal,
    })
    .from(invoices)
    .innerJoin(parties, eq(parties.id, invoices.partyId))
    .where(and(
      eq(invoices.businessId, ctx.businessId),
      eq(invoices.type, "sale"),
      sql`${invoices.status} != 'cancelled'`,
      isNull(invoices.deletedAt),
      ...buildBusinessDateFilter(invoices, { from: quarterStart, to: quarterEnd }),
    ));

  // Turnover = sum of all sale invoice subtotals (composition dealers charge 0% GST)
  let turnoverPaise = 0;
  for (const row of saleRows) {
    turnoverPaise += toPaise(row.subtotal);
  }

  // ── Fetch purchase invoices for the quarter (ITC to be reversed) ───
  const purchaseRows = await ctx.db
    .select({
      subtotal: invoices.subtotal,
      taxAmount: invoices.taxAmount,
      partyStateCode: parties.stateCode,
      partyState: parties.state,
      isReverseCharge: invoices.isReverseCharge,
    })
    .from(invoices)
    .innerJoin(parties, eq(parties.id, invoices.partyId))
    .where(and(
      eq(invoices.businessId, ctx.businessId),
      eq(invoices.type, "purchase"),
      sql`${invoices.status} != 'cancelled'`,
      isNull(invoices.deletedAt),
      ...buildBusinessDateFilter(invoices, { from: quarterStart, to: quarterEnd }),
    ));

  // ── Aggregate turnover and purchase tax using paise arithmetic ───

  let purchaseTaxCgst = 0;
  let purchaseTaxSgst = 0;
  let purchaseTaxIgst = 0;
  let purchaseTaxablePaise = 0;
  let rcmTaxCgst = 0, rcmTaxSgst = 0, rcmTaxIgst = 0;

  const bizStateCode = biz?.stateCode ?? null;

  for (const row of purchaseRows) {
    const taxablePaise = toPaise(row.subtotal);
    const taxPaise = toPaise(row.taxAmount);

    const sameState = bizStateCode && row.partyStateCode
      ? bizStateCode === row.partyStateCode
      : biz?.state && row.partyState
        ? biz.state.toLowerCase() === row.partyState.toLowerCase()
        : false;

    purchaseTaxablePaise += taxablePaise;

    if (row.isReverseCharge) {
      // RCM purchases: ITC is available but all must be reversed for composition dealers
      if (sameState) {
        const [c, s] = splitPaise(taxPaise);
        rcmTaxCgst += c;
        rcmTaxSgst += s;
      } else {
        rcmTaxIgst += taxPaise;
      }
    } else {
      // Normal purchase ITC — for composition dealers, ALL of this is reversed
      if (sameState) {
        const [c, s] = splitPaise(taxPaise);
        purchaseTaxCgst += c;
        purchaseTaxSgst += s;
      } else {
        purchaseTaxIgst += taxPaise;
      }
    }
  }

  // ── Build Table 4 — inward supplies ──────────────────────────

  const table4: GSTR4Table4 = {
    // Composition dealers charge 0% GST on outward — but Table 4B(ii) is the
    // turnover the flat rate is applied to. Tax fields stay zero.
    ownExempt: zeroRow(),
    ownNonExempt: {
      taxableValue: turnoverPaise,
      igst: 0,
      cgst: 0,
      sgst: 0,
      cess: 0,
    },
    inwardExempt: zeroRow(),
    inwardNonExempt: {
      taxableValue: purchaseTaxablePaise,
      cgst: purchaseTaxCgst,
      sgst: purchaseTaxSgst,
      igst: purchaseTaxIgst,
      cess: 0,
    },
    inwardReverseCharge: {
      taxableValue: 0,
      cgst: rcmTaxCgst,
      sgst: rcmTaxSgst,
      igst: rcmTaxIgst,
      cess: 0,
    },
    inwardIsd: zeroRow(),
    otherItc: zeroRow(),
    refund: zeroRow(),
  };

  // ── Build Table 5 — ITC reversed ─────────────────────────────

  // Composition dealers avail no credit at all, so the entire purchase tax
  // (including RCM) is reported as reversed under "others" (5C).
  // Rules 42/43 (5A) and Section 17(5) (5B) are not separately tracked
  // because the composition dealer never avails any ITC to begin with.
  const totalReversedCgst = purchaseTaxCgst + rcmTaxCgst;
  const totalReversedSgst = purchaseTaxSgst + rcmTaxSgst;
  const totalReversedIgst = purchaseTaxIgst + rcmTaxIgst;

  const table5: GSTR4Table5 = {
    rule42_43: zeroRow(),
    section17_5: zeroRow(),
    others: {
      taxableValue: purchaseTaxablePaise,
      cgst: totalReversedCgst,
      sgst: totalReversedSgst,
      igst: totalReversedIgst,
      cess: 0,
    },
    total: {
      taxableValue: purchaseTaxablePaise,
      cgst: totalReversedCgst,
      sgst: totalReversedSgst,
      igst: totalReversedIgst,
      cess: 0,
    },
  };

  // ── Build Table 6 — tax paid ─────────────────────────────────
  // Tax payable = turnover × compositionRate%
  // Since no ITC is available, all tax is paid via cash.

  const turnover = turnoverPaise / 100;
  const rateAsFraction = compositionRate / 100;
  const taxPayablePaise = Math.round(turnover * rateAsFraction * 100);

  const table6: GSTR4Table6 = {
    taxPayableOnTurnover: taxPayablePaise,
    taxPaidViaItc: 0,
    taxPaidViaCash: taxPayablePaise,
    excessItcUtilised: 0,
  };

  // ── Period label ─────────────────────────────────────────────
  const quarterNames = ["Q1 (Jan–Mar)", "Q2 (Apr–Jun)", "Q3 (Jul–Sep)", "Q4 (Oct–Dec)"];
  const period = `${quarterNames[quarter - 1]} ${year}`;

  // ── Total payable (equals tax on turnover, all cash) ─────────
  const taxPayable = taxPayablePaise;

  return {
    businessName: biz?.name ?? "",
    businessGstin: biz?.gstin ?? "",
    period,
    quarter,
    year,
    turnover: turnoverPaise,
    compositionRate,
    table4,
    table5,
    table6,
    taxPayable,
  };
}
