/**
 * Packs the CA handover reports into one ZIP. Plain module (no JSX) so the
 * packing logic stays independent of the UI. See gst-annual-csv.ts for helpers.
 */
import JSZip from "jszip";
import { buildReadme, isArr, pick, rec, rowsOf, toCsv } from "./gst-annual-csv";
import type { Row } from "./gst-annual-csv";

export interface PackResult {
  blob: Blob;
  count: number;
  financialYear: string;
}

export async function buildHandoverZip(p: {
  financialYear: string;
  generatedAt: string;
  period?: unknown;
  sections?: unknown;
  errors?: unknown;
}): Promise<PackResult> {
  const zip = new JSZip();
  const fy = p.financialYear;
  const s = rec(p.sections);
  const added: string[] = [];
  const add = (path: string, content: string) => {
    if (content) {
      zip.file(path, content);
      added.push(path);
    }
  };
  const dump = (key: string, out: string) => {
    if (Object.keys(rec(s[key])).length) add(out, JSON.stringify(s[key], null, 2));
  };

  const g1 = rec(s.gstr1Annual);
  const t = rec(g1.totals);
  if (Object.keys(g1).length) {
    add(
      "GST/GSTR1_annual_summary.csv",
      toCsv(["Metric", "Value"], [
        ["Financial Year", fy],
        ["Invoice Count", t.invoiceCount],
        ["Taxable Value", t.taxableValue],
        ["CGST", t.cgst],
        ["SGST", t.sgst],
        ["IGST", t.igst],
        ["Total Tax", t.totalTax],
        ["Total Invoice Value", t.totalInvoiceValue],
      ]),
    );
    add(
      "GST/GSTR1_monthly_breakdown.csv",
      toCsv(
        ["Month", "Invoices", "Taxable", "CGST", "SGST", "IGST", "Total Tax"],
        rowsOf(g1, "monthlyBreakdown").map(
          pick("period", "invoiceCount", "taxableValue", "cgst", "sgst", "igst", "totalTax"),
        ),
      ),
    );
    add(
      "GST/GSTR1_B2B_customers.csv",
      toCsv(
        ["GSTIN", "Customer", "Invoices", "Taxable", "CGST", "SGST", "IGST"],
        rowsOf(g1, "b2b").map(
          pick("partyGstin", "partyName", "invoiceCount", "taxableValue", "cgst", "sgst", "igst"),
        ),
      ),
    );
    add(
      "GST/GSTR1_HSN_summary.csv",
      toCsv(
        ["HSN", "Description", "Qty", "Taxable", "CGST", "SGST", "IGST", "Total"],
        rowsOf(g1, "hsn").map(
          pick("hsn", "description", "quantity", "taxableValue", "cgst", "sgst", "igst", "totalValue"),
        ),
      ),
    );
  }

  const g3 = rec(s.gstr3bAnnual);
  if (Object.keys(g3).length) {
    add(
      "GST/GSTR3B_monthly.csv",
      toCsv(
        ["Month", "Outward Taxable", "IGST", "CGST", "SGST", "ITC", "Tax Payable IGST"],
        rowsOf(g3, "monthlyBreakdown").map((r: Row) => [
          r.period, r.outwardTaxable, r.igst, r.cgst, r.sgst, r.itcTotal, rec(r.taxPayable).igst,
        ]),
      ),
    );
    const itc = rec(g3.itc);
    const pay = rec(g3.taxPayable);
    add(
      "GST/GSTR3B_annual_summary.csv",
      toCsv(["Metric", "Value"], [
        ["Eligible ITC (IGST)", itc.igst],
        ["Eligible ITC (CGST)", itc.cgst],
        ["Eligible ITC (SGST)", itc.sgst],
        ["Tax Payable IGST", pay.igst],
        ["Tax Payable CGST", pay.cgst],
        ["Tax Payable SGST", pay.sgst],
        ["Net Tax Payable", rec(g3.netTax).total],
      ]),
    );
  }

  const itc4 = rec(s.itcAnnual);
  if (Object.keys(itc4).length) {
    const tot = rec(rec(itc4.itcAvailable).total);
    const ni = rec(itc4.netItc);
    add("GST/ITC_annual_statement.csv", toCsv(
      ["Section", "IGST", "CGST", "SGST"],
      [
        ["Total eligible ITC (Table 4A)", tot.integratedTax, tot.centralTax, tot.stateTax],
        ["Net ITC after reversals", ni.integratedTax, ni.centralTax, ni.stateTax],
      ],
    ));
  }

  dump("gstr9", "GST/GSTR9_annual_return.json");
  dump("taxSummary", "GST/Tax_summary.json");
  dump("stockSummary", "Books/Stock_summary.json");

  const tb = rec(s.trialBalance);
  if (Object.keys(tb).length) {
    add("Financials/Trial_balance.csv", toCsv(
      ["Code", "Account", "Type", "Debit", "Credit", "Balance"],
      rowsOf(tb, "accounts").map(
        pick("accountCode", "accountName", "accountType", "debit", "credit", "balance"),
      ),
    ));
  }

  const pl = rec(s.profitAndLoss);
  if (Object.keys(pl).length) {
    const line = (section: string, r: Row): unknown[] =>
      [section, r.accountCode, r.accountName, r.amount];
    add("Financials/Profit_and_loss.csv", toCsv(
      ["Section", "Code", "Account", "Amount"],
      [
        ...rowsOf(pl, "income").map((r) => line("Income", r)),
        ...rowsOf(pl, "expenses").map((r) => line("Expense", r)),
        ["TOTAL", "", "Net Profit", pl.netProfit],
      ],
    ));
  }

  const bs = rec(s.balanceSheet);
  if (Object.keys(bs).length) {
    const line = (section: string, key: string): unknown[][] =>
      rowsOf(bs, key).map((r) => [section, r.accountCode, r.accountName, r.balance]);
    add("Financials/Balance_sheet.csv", toCsv(
      ["Section", "Code", "Account", "Balance"],
      [
        ...line("Assets", "assets"),
        ...line("Liabilities", "liabilities"),
        ...line("Equity", "equity"),
      ],
    ));
  }

  const addRegister = (key: string, out: string) => {
    const d = s[key];
    const rows = (isArr(d) ? d : rowsOf(rec(d), "data")) as Row[];
    if (!rows.length) return;
    const headers = Object.keys(rows[0]!);
    add(out, toCsv(headers, rows.map((r) => headers.map((h) => rec(r)[h]))));
  };
  addRegister("salesRegister", "Books/Sales_register.csv");
  addRegister("purchaseRegister", "Books/Purchase_register.csv");

  const period = rec(p.period);
  const failures: [string, string][] = Object.entries(rec(p.errors)).map(
    ([k, v]) => [k, String(v)],
  );
  add("README.md", buildReadme({
    financialYear: fy,
    generatedAt: p.generatedAt,
    from: String(period.from ?? ""),
    to: String(period.to ?? ""),
    files: added,
    errors: failures,
  }));

  return {
    blob: await zip.generateAsync({ type: "blob" }),
    count: added.length,
    financialYear: fy,
  };
}