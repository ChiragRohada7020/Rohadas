/**
 * GST reporting tools.
 *
 * Tools registered:
 *   gst_report     — generate GSTR1 or GSTR3B summary data for a given month/year
 *   gst_report_csv — get GSTR-1 data in CSV format ready for portal upload
 *   gst_gstr9      — GSTR-9 annual return summary
 *
 * Note: PDF generation is intentionally excluded. AI agents cannot consume
 * binary content in tool responses. The JSON report is designed to let agents
 * summarize GST liability, answer questions, and guide filing.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RohadasClient } from "../client.js";
import { wrapTool } from "../lib/errors.js";

const CURRENT_YEAR = new Date().getFullYear();

export function registerGstTools(server: McpServer, client: RohadasClient) {

  server.tool(
    "gst_report_csv",
    [
      "Get GSTR-1 data as a CSV string ready for upload to the GST portal.",
      "Returns the CSV content and a suggested filename (e.g. 'GSTR1_March_2024.csv').",
      "Save the CSV content to a file and upload it at https://www.gst.gov.in/.",
      "Month is 1–12 (1 = January, 3 = March, etc.).",
    ].join(" "),
    {
      month: z.number().int().min(1).max(12)
        .describe("Month number (1 = January, 12 = December)."),
      year: z.number().int().min(2020).max(CURRENT_YEAR + 1)
        .describe(`Year, e.g. ${CURRENT_YEAR}.`),
    },
    wrapTool(async (input) => {
      const result = await client.gst.gstr1CSV({ month: input.month, year: input.year });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    })
  );

  server.tool(
    "gst_report",
    [
      "Generate a GST report (GSTR1 or GSTR3B) for a specific month and year.",
      "GSTR1 = outward supplies summary (sales). GSTR3B = monthly return summary (sales + purchases + ITC).",
      "Returns JSON data — use this to answer 'What is our GST liability for March 2024?' or 'How much ITC can we claim this month?'",
      "Month is 1–12 (1 = January, 3 = March, etc.).",
      "Example: { report_type: 'gstr3b', month: 3, year: 2024 } for March 2024 GSTR3B.",
    ].join(" "),
    {
      report_type: z.enum(["gstr1", "gstr3b"])
        .describe("'gstr1' for outward supplies (sales) report. 'gstr3b' for monthly summary return."),
      month: z.number().int().min(1).max(12)
        .describe("Month number (1 = January, 12 = December)."),
      year: z.number().int().min(2020).max(CURRENT_YEAR + 1)
        .describe(`Year, e.g. ${CURRENT_YEAR}.`),
    },
    wrapTool(async (input) => {
      const report = input.report_type === "gstr1"
        ? await client.gst.gstr1({ month: input.month, year: input.year })
        : await client.gst.gstr3b({ month: input.month, year: input.year });

      const monthName = new Date(input.year, input.month - 1, 1)
        .toLocaleString("en-IN", { month: "long" });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(
            {
              ...report,
              _meta: {
                reportType: input.report_type.toUpperCase(),
                period: `${monthName} ${input.year}`,
              },
            },
            null,
            2
          ),
        }],
      };
    })
  );

  server.tool(
    "gst_gstr9",
    [
      "Get GSTR-9 annual return summary for a financial year.",
      "GSTR-9 is the annual GST return consolidating all monthly/quarterly filings.",
      "Returns total turnover, tax paid, ITC claimed, and other annual summary data.",
      "Financial year format: 'YYYY-YY' e.g. '2023-24' for FY 2023-2024 (April 2023 to March 2024).",
    ].join(" "),
    {
      financial_year: z.string().regex(/^\d{4}-\d{2}$/)
        .describe("Financial year in YYYY-YY format, e.g. '2023-24'."),
    },
    wrapTool(async (input) => {
      const result = await client.gst.gstr9({ financialYear: input.financial_year });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    })
  );

  server.tool(
    "gst_gstr4",
    [
      "Get the GSTR-4 quarterly return for a composition-scheme dealer.",
      "GSTR-4 replaced CMP-08 from FY 2019-20 and is the quarterly return composition dealers file.",
      "Composition dealers charge customers 0% GST and instead pay a flat rate on total TURNOVER,",
      "and they cannot avail input tax credit. Tax payable is therefore turnover × composition rate,",
      "and all purchase ITC is reported as reversed.",
      "Quarter is a CALENDAR quarter: Q1 = Jan-Mar, Q2 = Apr-Jun, Q3 = Jul-Sep, Q4 = Oct-Dec.",
    ].join(" "),
    {
      year: z.number().int().min(2020).max(2099)
        .describe("Calendar year of the quarter, e.g. 2026."),
      quarter: z.number().int().min(1).max(4)
        .describe("Calendar quarter 1-4 (Q1 = Jan-Mar)."),
      composition_rate: z.number().positive().max(100).optional()
        .describe("Flat composition rate as a percentage. Defaults to 1. Statutory rates: 1% goods traders, 0.5% non-specified goods manufacturers, 5% restaurants, 6% specified services."),
    },
    wrapTool(async (input) => {
      const result = await client.gst.gstr4({
        year: input.year,
        quarter: input.quarter,
        ...(input.composition_rate !== undefined
          ? { compositionRate: input.composition_rate }
          : {}),
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    })
  );
}
