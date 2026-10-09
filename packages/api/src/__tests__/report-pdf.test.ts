/**
 * report-pdf.test.ts — validates that every report PDF renderer produces a
 * well-formed PDF buffer from representative data. These tests exercise the
 * pure renderers (which only depend on pdfkit + the bundled Noto fonts), not
 * the DB-backed service layer.
 */

import { describe, it, expect } from "vitest";

function assertPdf(buf: Buffer): void {
  expect(buf.length).toBeGreaterThan(1000);
  expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(buf.subarray(buf.length - 16).toString()).toContain("%%EOF");
}

describe("report PDF renderers", () => {
  it("renders a trial balance", async () => {
    const { generateTrialBalancePDF } = await import("../lib/report-pdf-financial.js");
    const buf = await generateTrialBalancePDF({
      businessName: "Acme Traders",
      asOfDate: "2025-06-30T00:00:00.000Z",
      accounts: [
        { accountCode: "1000", accountName: "Cash in Hand", accountType: "asset", debit: "5000.00", credit: "0.00", balance: "5000.00" },
        { accountCode: "4000", accountName: "Sales", accountType: "income", debit: "0.00", credit: "10000.00", balance: "-10000.00" },
      ],
      totalDebit: "5000.00",
      totalCredit: "10000.00",
    });
    assertPdf(buf);
  });

  it("renders a profit & loss statement", async () => {
    const { generateProfitAndLossPDF } = await import("../lib/report-pdf-financial.js");
    const buf = await generateProfitAndLossPDF({
      businessName: "Acme Traders",
      fromDate: "2025-04-01T00:00:00.000Z",
      toDate: "2025-06-30T00:00:00.000Z",
      income: [{ accountCode: "4000", accountName: "Sales", amount: "10000.00" }],
      expenses: [{ accountCode: "5000", accountName: "Purchases", amount: "6000.00" }],
      totalIncome: "10000.00",
      totalExpenses: "6000.00",
      grossProfit: "4000.00",
      netProfit: "4000.00",
    });
    assertPdf(buf);
  });

  it("renders a balance sheet", async () => {
    const { generateBalanceSheetPDF } = await import("../lib/report-pdf-financial.js");
    const buf = await generateBalanceSheetPDF({
      businessName: "Acme Traders",
      asOfDate: "2025-06-30T00:00:00.000Z",
      assets: [{ accountCode: "1000", accountName: "Cash in Hand", balance: "5000.00" }],
      liabilities: [{ accountCode: "2000", accountName: "Accounts Payable", balance: "1000.00" }],
      equity: [{ accountCode: "3000", accountName: "Owner Capital", balance: "4000.00" }],
      totalAssets: "5000.00",
      totalLiabilities: "1000.00",
      totalEquity: "4000.00",
    });
    assertPdf(buf);
  });

  it("renders a daybook (landscape)", async () => {
    const { generateDaybookPDF } = await import("../lib/report-pdf-tabular.js");
    const buf = await generateDaybookPDF({
      businessName: "Acme Traders",
      fromDate: "2025-04-01T00:00:00.000Z",
      toDate: "2025-04-30T00:00:00.000Z",
      entries: [
        { time: "2025-04-05T10:00:00.000Z", entryType: "invoice", number: "INV-1", partyOrCategory: "Bob", debit: "0", credit: "11800.00", mode: null, status: "paid" },
        { time: "2025-04-06T10:00:00.000Z", entryType: "payment", number: "PAY-1", partyOrCategory: "Bob", debit: "11800.00", credit: "0", mode: "cash", status: null },
      ],
      summary: { totalSalesInvoiced: "11800.00", totalPurchaseInvoiced: "0.00", totalPaymentsReceived: "11800.00", totalPaymentsMade: "0.00", totalExpenses: "0.00", netCashMovement: "11800.00" },
    });
    assertPdf(buf);
  });

  it("renders a sales register", async () => {
    const { generateRegisterPDF } = await import("../lib/report-pdf-tabular.js");
    const buf = await generateRegisterPDF({
      businessName: "Acme Traders",
      title: "Sales Register",
      fromDate: "2025-04-01T00:00:00.000Z",
      toDate: "2025-04-30T00:00:00.000Z",
      rows: [
        { invoiceDate: "2025-04-05T10:00:00.000Z", invoiceNumber: "INV-1", partyName: "Bob", subtotal: "10000.00", taxAmount: "1800.00", totalAmount: "11800.00", amountPaid: "11800.00", status: "paid" },
      ],
      summary: { totalSubtotal: "10000.00", totalTax: "1800.00", totalAmount: "11800.00", count: 1 },
    });
    assertPdf(buf);
  });

  it("renders an outstanding report", async () => {
    const { generateOutstandingPDF } = await import("../lib/report-pdf-tabular.js");
    const buf = await generateOutstandingPDF({
      businessName: "Acme Traders",
      asOfDate: "2025-06-30T00:00:00.000Z",
      title: "Outstanding Report",
      receivables: {
        parties: [{ partyName: "Bob", partyPhone: null, current: "5000.00", days31_60: "0.00", days61_90: "0.00", days90Plus: "0.00", total: "5000.00", invoices: [] }],
        summary: { current: "5000.00", days31_60: "0.00", days61_90: "0.00", days90Plus: "0.00", total: "5000.00" },
      },
      payables: null,
    });
    assertPdf(buf);
  });

  it("renders a stock summary", async () => {
    const { generateStockSummaryPDF } = await import("../lib/report-pdf-tabular.js");
    const buf = await generateStockSummaryPDF({
      businessName: "Acme Traders",
      asOfDate: "2025-06-30T00:00:00.000Z",
      simpleItems: [{ itemName: "Widget", category: null, hsn: null, unit: "pcs", currentStock: "10", stockValue: "500.00", stockValueAtSale: "800.00" }],
      variantItems: [],
      summary: { totalCostValue: "500.00", totalSaleValue: "800.00", totalSkuCount: 1, lowStockCount: 0 },
    });
    assertPdf(buf);
  });

  it("renders a general ledger", async () => {
    const { generateGeneralLedgerPDF } = await import("../lib/report-pdf-tabular.js");
    const buf = await generateGeneralLedgerPDF({
      businessName: "Acme Traders",
      accountCode: "1000",
      accountName: "Cash in Hand",
      fromDate: "2025-04-01T00:00:00.000Z",
      toDate: "2025-04-30T00:00:00.000Z",
      entries: [
        { date: "2025-04-06T10:00:00.000Z", narration: "Payment Received PAY-1", sourceNumber: "PAY-1", debit: "11800.00", credit: "0.00", balance: "11800.00" },
      ],
      closingBalance: "11800.00",
    });
    assertPdf(buf);
  });

  it("renders a tax summary", async () => {
    const { generateTaxSummaryPDF } = await import("../lib/report-pdf-tabular.js");
    const buf = await generateTaxSummaryPDF({
      businessName: "Acme Traders",
      fromDate: "2025-04-01T00:00:00.000Z",
      toDate: "2025-04-30T00:00:00.000Z",
      salesBreakdown: [{ taxPercent: "18", invoiceCount: 1, taxableAmount: "10000.00", taxAmount: "1800.00" }],
      purchaseBreakdown: [],
      summary: { totalTaxCollected: "1800.00", totalTaxPaid: "0.00", netTaxLiability: "1800.00" },
    });
    assertPdf(buf);
  });

  it("renders a GSTR-1 working summary", async () => {
    const { generateGSTR1PDF } = await import("../lib/report-pdf-gst.js");
    const buf = await generateGSTR1PDF({
      period: "Apr 2025",
      businessGstin: "27ABCDE1234F1Z5",
      businessName: "Acme Traders",
      b2b: [{ partyGstin: "27VWXYZ5678G1Z0", partyName: "Bob Pvt Ltd", invoiceNumber: "INV-1", invoiceDate: "2025-04-05T00:00:00.000Z", invoiceType: "Regular", taxableValue: 10000, cgst: 900, sgst: 900, igst: 0, totalInvoiceValue: 11800 }],
      b2cLarge: [],
      b2cSmall: [{ taxRate: 18, taxableValue: 5000, cgst: 450, sgst: 450, igst: 0 }],
      hsn: [{ hsn: "8471", description: "Computers", quantity: 1, taxableValue: 15000, cgst: 1350, sgst: 1350, igst: 0, totalValue: 17700 }],
      creditNotes: [],
      debitNotes: [],
      totalTaxableValue: 15000,
      totalCgst: 1350,
      totalSgst: 1350,
      totalIgst: 0,
      totalTax: 2700,
      totalInvoiceValue: 17700,
      invoiceCount: 2,
    });
    assertPdf(buf);
  });

  it("renders a GSTR-3B working summary", async () => {
    const { generateGSTR3BPDF } = await import("../lib/report-pdf-gst.js");
    const buf = await generateGSTR3BPDF({
      period: "Apr 2025",
      businessGstin: "27ABCDE1234F1Z5",
      businessName: "Acme Traders",
      outwardSupplies: {
        taxable: { taxableValue: 15000, igst: 0, cgst: 1350, sgst: 1350 },
        zeroRated: { taxableValue: 0, igst: 0, cgst: 0, sgst: 0 },
        exempt: { taxableValue: 0, igst: 0, cgst: 0, sgst: 0 },
      },
      rcmSupplies: { taxableValue: "0.00", cgst: "0.00", sgst: "0.00", igst: "0.00" },
      interStateUnregistered: [],
      itc: { igst: 0, cgst: 500, sgst: 500, total: 1000 },
      taxPayable: { igst: 0, cgst: 1350, sgst: 1350 },
      netTax: { igst: 0, cgst: 850, sgst: 850, total: 1700 },
    });
    assertPdf(buf);
  });
});
