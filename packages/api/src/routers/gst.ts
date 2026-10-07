import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { invoices, businesses } from "@hisaabo/db";
import { router, viewerProcedure } from "../trpc.js";
import { requireCan } from "../lib/permissions.js";
import { generateGSTR1, generateGSTR3B, gstr1ToCSV, gstr1ToPortalJson } from "../lib/gst-reports.js";
import { generateGSTR9, gstr9ToPortalJson } from "../lib/gstr9-generator.js";
import { buildGSTR4 } from "../lib/gstr4-generator.js";
import { buildBusinessDateFilter } from "../lib/business-date.js";

// Generate 12 months of an Indian financial year (April → March).
function fyMonths(financialYear: number): Array<{ year: number; month: number }> {
  const months: Array<{ year: number; month: number }> = [];
  for (let m = 4; m <= 12; m++) months.push({ year: financialYear, month: m });
  for (let m = 1; m <= 3; m++) months.push({ year: financialYear + 1, month: m });
  return months;
}

export const gstRouter = router({
  // Reports are available for ALL businesses — GST-registered get GST terminology,
  // non-GST get generic financial report terminology. The data engine is identical.
  gstr1: viewerProcedure
    .input(z.object({
      year: z.number().int().min(2020).max(2099),
      month: z.number().int().min(1).max(12),
    }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "Report");
      return generateGSTR1(ctx.businessId, input.year, input.month, ctx.db);
    }),

  gstr3b: viewerProcedure
    .input(z.object({
      year: z.number().int().min(2020).max(2099),
      month: z.number().int().min(1).max(12),
    }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "Report");
      return generateGSTR3B(ctx.businessId, input.year, input.month, ctx.db);
    }),

  gstr1CSV: viewerProcedure
    .input(z.object({
      year: z.number().int().min(2020).max(2099),
      month: z.number().int().min(1).max(12),
    }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "Report");
      const report = await generateGSTR1(ctx.businessId, input.year, input.month, ctx.db);
      return { csv: gstr1ToCSV(report), filename: `GSTR1_${report.period.replace(" ", "_")}.csv` };
    }),

  // GSTR-1 portal JSON — produces the exact JSON schema accepted by the GST portal's
  // offline tool. Users can download this JSON and upload it directly to gstn.gov.in
  // instead of manually entering invoice data.
  gstr1Json: viewerProcedure
    .input(z.object({
      year: z.number().int().min(2020).max(2099),
      month: z.number().int().min(1).max(12),
    }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "Report");
      const report = await generateGSTR1(ctx.businessId, input.year, input.month, ctx.db);

      const [biz] = await ctx.db
        .select({ gstin: businesses.gstin, financialYearStart: businesses.financialYearStart })
        .from(businesses)
        .where(eq(businesses.id, ctx.businessId))
        .limit(1);

      const fp = String(input.month).padStart(2, "0") + String(input.year);
      const fyStart = biz?.financialYearStart ?? 4;
      const fy = input.month >= fyStart
        ? `${input.year}-${String(input.year + 1).slice(2)}`
        : `${input.year - 1}-${String(input.year).slice(2)}`;

      const portalJson = gstr1ToPortalJson(report, biz?.gstin ?? "", fy, fp);
      return {
        json: portalJson,
        filename: `GSTR1_${report.period.replace(" ", "_")}_portal.json`,
      };
    }),

  // GSTR-9: Annual return consolidating 12 months of GSTR-1 + GSTR-3B data.
  // Filed once per financial year (April–March). Tables 4-9 are generated from
  // the monthly report data — no separate data entry required.
  gstr9: viewerProcedure
    .input(z.object({
      financialYear: z.number().int().min(2020).max(2099), // Start year, e.g. 2025 for FY 2025-26
    }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "GstReport");
      return generateGSTR9(ctx.businessId, input.financialYear, ctx.db);
    }),

  // GSTR-9 portal JSON — produces the JSON schema accepted by the GST portal's
  // offline tool. Users can download this and upload directly to gstn.gov.in.
  gstr9Json: viewerProcedure
    .input(z.object({
      financialYear: z.number().int().min(2020).max(2099),
    }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "GstReport");
      const report = await generateGSTR9(ctx.businessId, input.financialYear, ctx.db);
      const portalJson = gstr9ToPortalJson(report);
      const fyLabel = report.financialYear.replace("-", "_");
      return {
        json: portalJson,
        filename: `GSTR9_FY${fyLabel}_portal.json`,
      };
    }),

  // CMP-08: Quarterly return for composition scheme dealers.
  // Composition dealers pay a flat tax on total outward supplies instead of
  // collecting GST from customers. The rate varies by category:
  //   1% for traders (manufacturers), 5% for restaurants, 6% for service providers.
  // This endpoint calculates total outward supplies for a quarter and the tax payable.
  cmp08: viewerProcedure
    .input(z.object({
      year: z.number().int().min(2020).max(2099),
      quarter: z.number().int().min(1).max(4),
    }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "Report");

      // Derive start and end months from quarter
      const startMonth = (input.quarter - 1) * 3 + 1; // Q1→1, Q2→4, Q3→7, Q4→10
      const quarterStart = new Date(input.year, startMonth - 1, 1);
      const quarterEnd = new Date(input.year, startMonth + 2, 0, 23, 59, 59); // last day of 3rd month

      const rows = await ctx.db.select({
        totalAmount: invoices.totalAmount,
        subtotal: invoices.subtotal,
      }).from(invoices)
        .where(and(
          eq(invoices.businessId, ctx.businessId),
          eq(invoices.type, "sale"),
          sql`${invoices.status} != 'cancelled'`,
          ...buildBusinessDateFilter(invoices, { from: quarterStart, to: quarterEnd }),
        ));

      let taxableValue = 0;
      for (const row of rows) {
        taxableValue += parseFloat(row.subtotal);
      }

      // Default composition rate for traders: 1%.
      // Businesses can override this; we default to the lowest rate.
      // 1% for traders/manufacturers, 5% for restaurants, 6% for services.
      const compositionRate = 0.01;
      const taxPayable = taxableValue * compositionRate;

      return {
        taxableValue: taxableValue.toFixed(2),
        taxPayable: taxPayable.toFixed(2),
        quarterStart: quarterStart.toISOString(),
        quarterEnd: quarterEnd.toISOString(),
      };
    }),

  // Annual GSTR-1: the twelve monthly returns summed, for CA reconciliation.
  gstr1Annual: viewerProcedure
    .input(z.object({ financialYear: z.number().int().min(2020).max(2099) }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "Report");
      const months = fyMonths(input.financialYear);
      const reports = await Promise.all(
        months.map(({ year, month }) => generateGSTR1(ctx.businessId, year, month, ctx.db)),
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

      const b2bMap = new Map<string, { partyGstin: string; partyName: string; invoiceCount: number; taxableValue: number; cgst: number; sgst: number; igst: number }>();
      for (const r of reports) {
        for (const b of r.b2b) {
          const e = b2bMap.get(b.partyGstin) ?? { partyGstin: b.partyGstin, partyName: b.partyName, invoiceCount: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0 };
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

      const hsnMap = new Map<string, { hsn: string; description: string; quantity: number; taxableValue: number; cgst: number; sgst: number; igst: number }>();
      for (const r of reports) {
        for (const h of r.hsn) {
          const e = hsnMap.get(h.hsn) ?? { hsn: h.hsn, description: h.description, quantity: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0 };
          e.quantity += h.quantity;
          e.taxableValue += h.taxableValue;
          e.cgst += h.cgst;
          e.sgst += h.sgst;
          e.igst += h.igst;
          hsnMap.set(h.hsn, e);
        }
      }

      return {
        financialYear: input.financialYear,
        totals,
        monthlyBreakdown,
        b2b: [...b2bMap.values()],
        b2cSmall: [...b2cMap.values()].sort((a, b) => a.taxRate - b.taxRate),
        hsn: [...hsnMap.values()],
      };
    }),

  gstr1AnnualCsv: viewerProcedure
    .input(z.object({ financialYear: z.number().int().min(2020).max(2099) }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "Report");
      const months = fyMonths(input.financialYear);
      const reports = await Promise.all(
        months.map(({ year, month }) => generateGSTR1(ctx.businessId, year, month, ctx.db)),
      );
      const header = ["Period", "Invoice Count", "Taxable Value", "CGST", "SGST", "IGST", "Total Tax", "Total Invoice Value"];
      const body = reports.map((r, i) =>
        [`${months[i]!.year}-${String(months[i]!.month).padStart(2, "0")}`,
          String(r.invoiceCount), r.totalTaxableValue.toFixed(2), r.totalCgst.toFixed(2),
          r.totalSgst.toFixed(2), r.totalIgst.toFixed(2), r.totalTax.toFixed(2), r.totalInvoiceValue.toFixed(2)].join(","),
      );
      return { csv: [header.join(","), ...body].join("\n"), filename: `GSTR1_Annual_FY${input.financialYear}.csv` };
    }),


  // Annual GSTR-3B: twelve months added up.
  gstr3bAnnual: viewerProcedure
    .input(z.object({ financialYear: z.number().int().min(2020).max(2099) }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "Report");
      const months = fyMonths(input.financialYear);
      const reports = await Promise.all(
        months.map(({ year, month }) => generateGSTR3B(ctx.businessId, year, month, ctx.db)),
      );

      const sum3 = (get: (r: (typeof reports)[number]) => { taxableValue: number; igst: number; cgst: number; sgst: number }) =>
        reports.reduce(
          (acc, r) => {
            const v = get(r);
            return { taxableValue: acc.taxableValue + v.taxableValue, igst: acc.igst + v.igst, cgst: acc.cgst + v.cgst, sgst: acc.sgst + v.sgst };
          },
          { taxableValue: 0, igst: 0, cgst: 0, sgst: 0 },
        );

      const outwardSupplies = {
        taxable: sum3((r) => r.outwardSupplies.taxable),
        zeroRated: sum3((r) => r.outwardSupplies.zeroRated),
        exempt: sum3((r) => r.outwardSupplies.exempt),
      };
      const itc = reports.reduce(
        (acc, r) => ({ igst: acc.igst + r.itc.igst, cgst: acc.cgst + r.itc.cgst, sgst: acc.sgst + r.itc.sgst, total: acc.total + r.itc.total }),
        { igst: 0, cgst: 0, sgst: 0, total: 0 },
      );
      const taxPayable = reports.reduce(
        (acc, r) => ({ igst: acc.igst + r.taxPayable.igst, cgst: acc.cgst + r.taxPayable.cgst, sgst: acc.sgst + r.taxPayable.sgst }),
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
      }));

      return { financialYear: input.financialYear, outwardSupplies, itc, taxPayable, netTax, monthlyBreakdown };
    }),

  // GSTR-4: quarterly return for composition-scheme dealers.
  gstr4: viewerProcedure
    .input(z.object({
      year: z.number().int().min(2020).max(2099),
      quarter: z.number().int().min(1).max(4),
      compositionRate: z.number().min(0).max(20),
    }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "Report");
      return buildGSTR4(ctx, input.year, input.quarter, input.compositionRate);
    }),

  gstr4Json: viewerProcedure
    .input(z.object({
      year: z.number().int().min(2020).max(2099),
      quarter: z.number().int().min(1).max(4),
      compositionRate: z.number().min(0).max(20),
    }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "Report");
      const data = await buildGSTR4(ctx, input.year, input.quarter, input.compositionRate);
      return { json: JSON.stringify(data), filename: `GSTR4_${data.period}.json` };
    }),

});
