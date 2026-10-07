/**
 * gstr9-generator.ts — Annual GSTR-9 return aggregation
 *
 * WHY THIS FILE EXISTS:
 * GSTR-9 is the annual GST return consolidating 12 months of GSTR-1 + GSTR-3B
 * data (April to March). This module aggregates monthly report data into the
 * structured tables required by the GST portal.
 *
 * Financial year convention: financialYear=2025 means FY 2025-26
 * (April 2025 through March 2026).
 *
 * Data sources:
 *   - generateGSTR1()  → Part II outward supply tables (4, 5)
 *   - generateGSTR3B() → Part III ITC tables (6, 7, 8) + Part IV tax paid (9)
 *
 * Money: all numeric values are accumulated as integer paise internally; the return type exposes
 * are divided by 100 to produce rupee values. No DB NUMERIC
 * casting is required here — we read from the same invoice tables that
 * generateGSTR1/3B use.
 */

import type { TenantDatabase } from "@hisaabo/db";
import { generateGSTR1, generateGSTR3B, type GSTR1Report, type GSTR3BReport } from "./gst-reports.js";
import { toPaise } from "@hisaabo/shared";

// ── Types ──────────────────────────────────────────────────────

/** A single tax-split row used in several GSTR-9 tables */
export interface TaxRow {
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
}

/** GSTR-9 Table 4 — Outward supplies (taxable) */
export interface GSTR9Table4 {
  /** 4A: Taxable outward supplies (B2B, inter-state, exports etc.) */
  taxableSuppliesB2B: TaxRow;
  /** 4B: Outward supplies to unregistered (B2C large + small) */
  taxableSuppliesB2C: TaxRow;
  /** 4C: Zero-rated supplies with payment of tax */
  zeroRatedWithTax: TaxRow;
  /** 4D: Exempted supplies */
  exempted: TaxRow;
  /** 4I: Net credit notes issued */
  creditNotes: TaxRow;
  /** 4J: Net debit notes issued */
  debitNotes: TaxRow;
}

/** GSTR-9 Table 5 — Outward supplies on which tax is NOT payable */
export interface GSTR9Table5 {
  /** 5A: Zero-rated without payment of tax */
  zeroRatedWithoutTax: TaxRow;
  /** 5B: Nil-rated supplies */
  nilRated: TaxRow;
  /** 5D: Non-GST outward supplies */
  nonGst: TaxRow;
}

/** GSTR-9 Table 6 — ITC availed during the year */
export interface GSTR9Table6 {
  /** 6A: Total ITC as per auto-populated GSTR-3B */
  totalItcGstr3B: TaxRow;
  /** 6B: ITC on imports of goods */
  itcImports: TaxRow;
  /** 6C: ITC on inward supplies from ISD */
  itcIsd: TaxRow;
  /** 6D: ITC on all other inward supplies (purchases) */
  itcOtherInward: TaxRow;
  /** 6E: ITC on inward supplies under reverse charge */
  itcReverseCharge: TaxRow;
  /** 6H: ITC reversed (Rules 42/43 / Section 17(5) ineligible) */
  itcReversed: TaxRow;
  /** 6J: Net ITC available (6A minus 6H) */
  netItc: TaxRow;
}

/** GSTR-9 Table 7 — ITC reversed and ineligible */
export interface GSTR9Table7 {
  /** 7A: As per Rule 42 (proportionate reversal) */
  rule42: TaxRow;
  /** 7B: As per Rule 43 */
  rule43: TaxRow;
  /** 7H: Other reversals */
  other: TaxRow;
  /** Total reversals */
  total: TaxRow;
}

/** GSTR-9 Table 8 — Other ITC details */
export interface GSTR9Table8 {
  /** 8A: ITC as per GSTR-2A (auto-populated) */
  itcGstr2A: TaxRow;
  /** 8B: ITC booked in current FY from Table 6 */
  itcBookedCurrentFY: TaxRow;
  /** 8C: ITC booked in following FY */
  itcBookedFollowingFY: TaxRow;
  /** 8D: ITC lapsed (8A minus 8B minus 8C) */
  itcLapsed: TaxRow;
}

/** GSTR-9 Table 9 — Tax paid as declared in GSTR-3B */
export interface GSTR9Table9 {
  igstThroughCash: number;
  igstThroughITC: number;
  cgstThroughCash: number;
  cgstThroughITC: number;
  sgstThroughCash: number;
  sgstThroughITC: number;
  cessThroughCash: number;
  cessThroughITC: number;
}

/** Summary of an individual month's aggregated data — useful for partial year handling */
export interface MonthlyAggregate {
  year: number;
  month: number;
  gstr1: GSTR1Report;
  gstr3b: GSTR3BReport;
}

/** Top-level GSTR-9 Report */
export interface GSTR9Report {
  /** Business identifiers */
  businessGstin: string;
  businessName: string;
  /** "2025-26" for financialYear=2025 */
  financialYear: string;
  /** April of start year to March of end year */
  periodStart: string;
  periodEnd: string;

  // ── Part II: Outward supplies ──────────────────────────────
  table4: GSTR9Table4;
  table5: GSTR9Table5;

  /** Aggregate of all outward supply totals for Part II */
  partIITotals: TaxRow;

  // ── Part III: ITC ──────────────────────────────────────────
  table6: GSTR9Table6;
  table7: GSTR9Table7;
  table8: GSTR9Table8;

  // ── Part IV: Tax paid ──────────────────────────────────────
  table9: GSTR9Table9;

  // ── Part V: Particulars (simplified) ─────────────────────
  /** 10: Aggregate value of amendments to taxable outward supplies */
  table10: TaxRow;
  /** 11: Aggregate value of amendments to taxable inward supplies */
  table11: TaxRow;

  /** Monthly breakdown for audit / reconciliation */
  monthlyBreakdown: MonthlyAggregate[];
}

// ── Helpers ────────────────────────────────────────────────────

function zeroRow(): TaxRow {
  return { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
}

function addRow(a: TaxRow, b: TaxRow): TaxRow {
  const tv = toPaise(a.taxableValue) + toPaise(b.taxableValue);
  const cg = toPaise(a.cgst) + toPaise(b.cgst);
  const sg = toPaise(a.sgst) + toPaise(b.sgst);
  const ig = toPaise(a.igst) + toPaise(b.igst);
  const ce = toPaise(a.cess) + toPaise(b.cess);
  return {
    taxableValue: tv / 100,
    cgst: cg / 100,
    sgst: sg / 100,
    igst: ig / 100,
    cess: ce / 100,
  };
}

/** Sum credit notes from a GSTR-1 report into a TaxRow */
function sumCreditNotes(gstr1: GSTR1Report): TaxRow {
  let tv = 0, cgst = 0, sgst = 0, igst = 0;
  for (const cn of gstr1.creditNotes) {
    const taxPaise = toPaise(cn.taxAmount);
    const taxablePaise = toPaise(cn.taxableAmount);
    // We don't have per-note CGST/SGST/IGST split stored — use half each as approximation
    tv += taxablePaise;
    cgst += Math.floor(taxPaise / 2);
    sgst += taxPaise - Math.floor(taxPaise / 2);
  }
  return {
    taxableValue: tv / 100,
    cgst: cgst / 100,
    sgst: sgst / 100,
    igst: igst / 100,
    cess: 0,
  };
}

/** Sum debit notes from a GSTR-1 report into a TaxRow */
function sumDebitNotes(gstr1: GSTR1Report): TaxRow {
  let tv = 0, cgst = 0, sgst = 0, igst = 0;
  for (const dn of gstr1.debitNotes) {
    const taxPaise = toPaise(dn.taxAmount);
    const taxablePaise = toPaise(dn.taxableAmount);
    tv += taxablePaise;
    cgst += Math.floor(taxPaise / 2);
    sgst += taxPaise - Math.floor(taxPaise / 2);
  }
  return {
    taxableValue: tv / 100,
    cgst: cgst / 100,
    sgst: sgst / 100,
    igst: igst / 100,
    cess: 0,
  };
}

/** Build GSTR-9 portal JSON (simplified structure for upload) */
export function gstr9ToPortalJson(
  report: GSTR9Report,
): Record<string, unknown> {
  const fmtAmt = (n: number) => parseFloat(n.toFixed(2));

  // Table 4 — outward supplies
  const t4 = {
    "4A": {
      txval: fmtAmt(report.table4.taxableSuppliesB2B.taxableValue),
      iamt: fmtAmt(report.table4.taxableSuppliesB2B.igst),
      camt: fmtAmt(report.table4.taxableSuppliesB2B.cgst),
      samt: fmtAmt(report.table4.taxableSuppliesB2B.sgst),
      csamt: 0,
    },
    "4B": {
      txval: fmtAmt(report.table4.taxableSuppliesB2C.taxableValue),
      iamt: fmtAmt(report.table4.taxableSuppliesB2C.igst),
      camt: fmtAmt(report.table4.taxableSuppliesB2C.cgst),
      samt: fmtAmt(report.table4.taxableSuppliesB2C.sgst),
      csamt: 0,
    },
    "4C": {
      txval: fmtAmt(report.table4.zeroRatedWithTax.taxableValue),
      iamt: fmtAmt(report.table4.zeroRatedWithTax.igst),
      csamt: 0,
    },
    "4D": {
      txval: fmtAmt(report.table4.exempted.taxableValue),
    },
    "4I": {
      txval: fmtAmt(report.table4.creditNotes.taxableValue),
      iamt: fmtAmt(report.table4.creditNotes.igst),
      camt: fmtAmt(report.table4.creditNotes.cgst),
      samt: fmtAmt(report.table4.creditNotes.sgst),
      csamt: 0,
    },
    "4J": {
      txval: fmtAmt(report.table4.debitNotes.taxableValue),
      iamt: fmtAmt(report.table4.debitNotes.igst),
      camt: fmtAmt(report.table4.debitNotes.cgst),
      samt: fmtAmt(report.table4.debitNotes.sgst),
      csamt: 0,
    },
  };

  // Table 6 — ITC
  const t6 = {
    "6A": {
      iamt: fmtAmt(report.table6.totalItcGstr3B.igst),
      camt: fmtAmt(report.table6.totalItcGstr3B.cgst),
      samt: fmtAmt(report.table6.totalItcGstr3B.sgst),
      csamt: 0,
    },
    "6D": {
      iamt: fmtAmt(report.table6.itcOtherInward.igst),
      camt: fmtAmt(report.table6.itcOtherInward.cgst),
      samt: fmtAmt(report.table6.itcOtherInward.sgst),
      csamt: 0,
    },
    "6E": {
      iamt: fmtAmt(report.table6.itcReverseCharge.igst),
      camt: fmtAmt(report.table6.itcReverseCharge.cgst),
      samt: fmtAmt(report.table6.itcReverseCharge.sgst),
      csamt: 0,
    },
    "6J": {
      iamt: fmtAmt(report.table6.netItc.igst),
      camt: fmtAmt(report.table6.netItc.cgst),
      samt: fmtAmt(report.table6.netItc.sgst),
      csamt: 0,
    },
  };

  // Table 9 — tax paid
  const t9 = {
    igst: { cash: fmtAmt(report.table9.igstThroughCash), itc: fmtAmt(report.table9.igstThroughITC) },
    cgst: { cash: fmtAmt(report.table9.cgstThroughCash), itc: fmtAmt(report.table9.cgstThroughITC) },
    sgst: { cash: fmtAmt(report.table9.sgstThroughCash), itc: fmtAmt(report.table9.sgstThroughITC) },
    cess: { cash: fmtAmt(report.table9.cessThroughCash), itc: fmtAmt(report.table9.cessThroughITC) },
  };

  return {
    gstin: report.businessGstin,
    fy: report.financialYear,
    ret_period: report.periodStart,
    table4: t4,
    table5: {
      "5A": { txval: 0, iamt: 0, csamt: 0 },
      "5B": { txval: 0 },
      "5D": { txval: 0 },
    },
    table6: t6,
    table9: t9,
  };
}

// ── Generator ──────────────────────────────────────────────────

/**
 * Generate the full GSTR-9 annual return for a business.
 *
 * @param businessId    - Business UUID
 * @param financialYear - Start year of the FY (e.g. 2025 for FY 2025-26)
 * @param db            - Tenant database instance
 */
export async function generateGSTR9(
  businessId: string,
  financialYear: number,
  db: TenantDatabase,
): Promise<GSTR9Report> {
  // FY runs April (month 4) of financialYear to March (month 3) of financialYear+1
  // Build list of (year, month) tuples covering all 12 months
  const months: Array<{ year: number; month: number }> = [];
  for (let m = 4; m <= 12; m++) {
    months.push({ year: financialYear, month: m });
  }
  for (let m = 1; m <= 3; m++) {
    months.push({ year: financialYear + 1, month: m });
  }

  // Fetch all 12 months in parallel
  const monthlyData: MonthlyAggregate[] = await Promise.all(
    months.map(async ({ year, month }) => {
      const [gstr1, gstr3b] = await Promise.all([
        generateGSTR1(businessId, year, month, db),
        generateGSTR3B(businessId, year, month, db),
      ]);
      return { year, month, gstr1, gstr3b };
    }),
  );

  // Collect business identifiers from first month (they're stable across months)
  const firstMonth = monthlyData[0]!;
  const businessGstin = firstMonth.gstr1.businessGstin;
  const businessName = firstMonth.gstr1.businessName;

  // ── Part II: Table 4 aggregation ──────────────────────────

  // 4A: B2B taxable supplies
  let t4B2B = zeroRow();
  // 4B: B2C taxable supplies (large + small)
  let t4B2C = zeroRow();
  // 4C: Zero-rated with tax payment (not tracked → remains zero)
  const t4ZeroRated = zeroRow();
  // 4D: Exempted (not tracked → remains zero)
  const t4Exempted = zeroRow();
  // 4I: Credit notes
  let t4CreditNotes = zeroRow();
  // 4J: Debit notes
  let t4DebitNotes = zeroRow();

  for (const { gstr1 } of monthlyData) {
    // B2B: sum all b2b entries
    for (const inv of gstr1.b2b) {
      t4B2B = addRow(t4B2B, {
        taxableValue: inv.taxableValue,
        cgst: inv.cgst,
        sgst: inv.sgst,
        igst: inv.igst,
        cess: 0,
      });
    }

    // B2C large: sum by state entries
    for (const entry of gstr1.b2cLarge) {
      t4B2C = addRow(t4B2C, {
        taxableValue: entry.taxableValue,
        cgst: entry.cgst,
        sgst: entry.sgst,
        igst: entry.igst,
        cess: 0,
      });
    }

    // B2C small: sum across all tax-rate buckets
    for (const entry of gstr1.b2cSmall) {
      t4B2C = addRow(t4B2C, {
        taxableValue: entry.taxableValue,
        cgst: entry.cgst,
        sgst: entry.sgst,
        igst: entry.igst,
        cess: 0,
      });
    }

    // Credit/debit notes
    t4CreditNotes = addRow(t4CreditNotes, sumCreditNotes(gstr1));
    t4DebitNotes = addRow(t4DebitNotes, sumDebitNotes(gstr1));
  }

  const table4: GSTR9Table4 = {
    taxableSuppliesB2B: t4B2B,
    taxableSuppliesB2C: t4B2C,
    zeroRatedWithTax: t4ZeroRated,
    exempted: t4Exempted,
    creditNotes: t4CreditNotes,
    debitNotes: t4DebitNotes,
  };

  // Table 5: Tax-exempt supplies — not tracked in current invoice model
  const table5: GSTR9Table5 = {
    zeroRatedWithoutTax: zeroRow(),
    nilRated: zeroRow(),
    nonGst: zeroRow(),
  };

  // ── Part II totals (outward) ───────────────────────────────
  let partIITotals = zeroRow();
  partIITotals = addRow(partIITotals, t4B2B);
  partIITotals = addRow(partIITotals, t4B2C);
  // Debit notes add, credit notes reduce
  partIITotals = addRow(partIITotals, t4DebitNotes);
  partIITotals = {
    taxableValue: partIITotals.taxableValue - t4CreditNotes.taxableValue,
    cgst: partIITotals.cgst - t4CreditNotes.cgst,
    sgst: partIITotals.sgst - t4CreditNotes.sgst,
    igst: partIITotals.igst - t4CreditNotes.igst,
    cess: 0,
  };

  // ── Part III: ITC aggregation (Tables 6-8) ──────────────────

  // Aggregate ITC from GSTR-3B across all months
  let itcTotal = zeroRow();    // 6A: total from GSTR-3B (all purchases)
  let itcRcm = zeroRow();      // 6E: reverse charge ITC

  for (const { gstr3b } of monthlyData) {
    itcTotal = addRow(itcTotal, {
      taxableValue: 0,
      cgst: gstr3b.itc.cgst,
      sgst: gstr3b.itc.sgst,
      igst: gstr3b.itc.igst,
      cess: 0,
    });

    // RCM ITC from rcmSupplies tax amounts
    itcRcm = addRow(itcRcm, {
      taxableValue: toPaise(gstr3b.rcmSupplies.taxableValue) / 100,
      cgst: toPaise(gstr3b.rcmSupplies.cgst) / 100,
      sgst: toPaise(gstr3b.rcmSupplies.sgst) / 100,
      igst: toPaise(gstr3b.rcmSupplies.igst) / 100,
      cess: 0,
    });
  }

  // 6D: other inward supplies = total ITC minus RCM ITC
  const itcOtherInward: TaxRow = {
    taxableValue: 0,
    cgst: Math.max(0, toPaise(itcTotal.cgst) - toPaise(itcRcm.cgst)) / 100,
    sgst: Math.max(0, toPaise(itcTotal.sgst) - toPaise(itcRcm.sgst)) / 100,
    igst: Math.max(0, toPaise(itcTotal.igst) - toPaise(itcRcm.igst)) / 100,
    cess: 0,
  };

  const table6: GSTR9Table6 = {
    totalItcGstr3B: itcTotal,
    itcImports: zeroRow(),    // imports not tracked
    itcIsd: zeroRow(),        // ISD not tracked
    itcOtherInward,
    itcReverseCharge: itcRcm,
    itcReversed: zeroRow(),   // reversals not tracked separately
    netItc: itcTotal,         // net = total when reversals are zero
  };

  // Table 7: ITC reversed — not tracked separately, all zeros
  const table7: GSTR9Table7 = {
    rule42: zeroRow(),
    rule43: zeroRow(),
    other: zeroRow(),
    total: zeroRow(),
  };

  // Table 8: Other ITC details — simplified
  const table8: GSTR9Table8 = {
    itcGstr2A: itcTotal,        // treat GSTR-3B total as proxy for GSTR-2A
    itcBookedCurrentFY: itcTotal,
    itcBookedFollowingFY: zeroRow(),
    itcLapsed: zeroRow(),
  };

  // ── Part IV: Tax paid (Table 9) ────────────────────────────

  // Aggregate total output tax and net tax from GSTR-3B
  let totalOutputIgstPaise = 0;
  let totalOutputCgstPaise = 0;
  let totalOutputSgstPaise = 0;
  let totalItcIgstPaise = 0;
  let totalItcCgstPaise = 0;
  let totalItcSgstPaise = 0;

  for (const { gstr3b } of monthlyData) {
    totalOutputIgstPaise += toPaise(gstr3b.taxPayable.igst);
    totalOutputCgstPaise += toPaise(gstr3b.taxPayable.cgst);
    totalOutputSgstPaise += toPaise(gstr3b.taxPayable.sgst);
    totalItcIgstPaise += toPaise(gstr3b.itc.igst);
    totalItcCgstPaise += toPaise(gstr3b.itc.cgst);
    totalItcSgstPaise += toPaise(gstr3b.itc.sgst);
  }

  // Cash paid = output tax minus ITC (clamped at 0; negative = credit carryforward)
  const cashIgst = Math.max(0, totalOutputIgstPaise - totalItcIgstPaise) / 100;
  const cashCgst = Math.max(0, totalOutputCgstPaise - totalItcCgstPaise) / 100;
  const cashSgst = Math.max(0, totalOutputSgstPaise - totalItcSgstPaise) / 100;

  // ITC utilised = min(output tax, ITC available)
  const utilIgst = Math.min(totalOutputIgstPaise, totalItcIgstPaise) / 100;
  const utilCgst = Math.min(totalOutputCgstPaise, totalItcCgstPaise) / 100;
  const utilSgst = Math.min(totalOutputSgstPaise, totalItcSgstPaise) / 100;

  const table9: GSTR9Table9 = {
    igstThroughCash: cashIgst,
    igstThroughITC: utilIgst,
    cgstThroughCash: cashCgst,
    cgstThroughITC: utilCgst,
    sgstThroughCash: cashSgst,
    sgstThroughITC: utilSgst,
    cessThroughCash: 0,
    cessThroughITC: 0,
  };

  // ── Part V: Tables 10–11 (amendments) — zero for now ──────
  const table10 = zeroRow();
  const table11 = zeroRow();

  return {
    businessGstin,
    businessName,
    financialYear: `${financialYear}-${String(financialYear + 1).slice(2)}`,
    periodStart: `Apr ${financialYear}`,
    periodEnd: `Mar ${financialYear + 1}`,
    table4,
    table5,
    partIITotals,
    table6,
    table7,
    table8,
    table9,
    table10,
    table11,
    monthlyBreakdown: monthlyData,
  };
}
