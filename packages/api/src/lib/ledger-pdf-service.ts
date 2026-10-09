/**
 * ledger-pdf-service.ts — builds a party ledger PDF from live data.
 *
 * WHY THIS FILE EXISTS:
 * The HTTP route (`GET /api/parties/:id/ledger.pdf`) and the
 * `reports.sendLedgerEmail` / `reports.sendLedgerWhatsApp` mutations all need
 * the identical statement. Keeping the query in one place stops the download
 * and the emailed copy from drifting apart.
 */

import { eq, and, isNull, inArray, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { invoices, payments, parties, businesses, bankAccounts } from "@hisaabo/db";
import { money } from "@hisaabo/shared";
import { buildBusinessDateFilter } from "./business-date.js";
import { generateLedgerPDF, type LedgerEntry } from "./ledger-pdf.js";

export interface LedgerPdfBundle {
  pdfBuffer: Buffer;
  fileName: string;
  partyName: string;
  partyEmail: string | null;
  partyPhone: string | null;
  closingBalance: string;
}

/**
 * Load a party statement and render its ledger PDF.
 *
 * @returns `null` when the party does not exist in this business.
 */
export async function buildPartyLedgerPdf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  businessId: string,
  partyId: string,
  fromDate?: Date | null,
  toDate?: Date | null,
): Promise<LedgerPdfBundle | null> {
  const [party] = await db
    .select()
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.businessId, businessId)))
    .limit(1);

  if (!party) return null;

  const [biz] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);

  const invoiceConditions = [
    eq(invoices.partyId, partyId),
    eq(invoices.businessId, businessId),
    // Financial documents only — but that includes credit notes, debit notes and
    // returns, which the on-screen ledger shows. Filtering to 'invoice' alone
    // made the PDF closing balance disagree with the screen for any party that
    // had a return.
    inArray(invoices.documentType, [
      "invoice",
      "credit_note",
      "sales_return",
      "purchase_return",
      "debit_note",
    ]),
    sql`${invoices.status} NOT IN ('cancelled')`,
    isNull(invoices.deletedAt),
  ] as Parameters<typeof and>[0][];
  const paymentConditions = [
    eq(payments.partyId, partyId),
    eq(payments.businessId, businessId),
    // Soft-deleted payments must not reach the PDF — they were inflating the
    // closing balance printed on the statement.
    isNull(payments.deletedAt),
  ] as Parameters<typeof and>[0][];

  invoiceConditions.push(...buildBusinessDateFilter(invoices, { from: fromDate ?? undefined, to: toDate ?? undefined }));
  paymentConditions.push(...buildBusinessDateFilter(payments, { from: fromDate ?? undefined, to: toDate ?? undefined }));

  const [partyInvoices, partyPayments] = await Promise.all([
    db.select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      date: invoices.invoiceDate,
      type: invoices.type,
      documentType: invoices.documentType,
      totalAmount: invoices.totalAmount,
      status: invoices.status,
    }).from(invoices).where(and(...invoiceConditions)).orderBy(invoices.invoiceDate),

    db.select({
      id: payments.id,
      paymentNumber: payments.paymentNumber,
      date: payments.paymentDate,
      amount: payments.amount,
      mode: payments.mode,
      // Which invoice this payment settled — drives the debit/credit side.
      // A party can be BOTH a customer and a supplier, so the party's own
      // declared type is not a reliable direction signal.
      settledType: sql<string | null>`(
        SELECT i.type FROM payment_allocations pa
        JOIN invoices i ON i.id = pa.invoice_id
        WHERE pa.payment_id = payments.id
        ORDER BY pa.id LIMIT 1
      )`,
      legacySettledType: sql<string | null>`(
        SELECT i.type FROM invoices i WHERE i.id = payments.invoice_id
      )`,
    }).from(payments).where(and(...paymentConditions)).orderBy(payments.paymentDate),
  ]);

  // Mirrors party.ledger: returns reverse the normal direction, and a purchase
  // debit note reduces the payable rather than increasing it.
  const DOC_LABELS: Record<string, string> = {
    invoice: "", credit_note: "Credit Note", sales_return: "Sales Return",
    purchase_return: "Purchase Return", debit_note: "Debit Note",
  };
  const isReduction = (type: string, dt: string) =>
    type === "purchase"
      ? ["credit_note", "purchase_return", "debit_note"].includes(dt)
      : ["credit_note", "sales_return"].includes(dt);

  const entries = [
    ...partyInvoices.map((inv: {
      date: Date;
      type: string;
      documentType: string;
      invoiceNumber: string;
      totalAmount: string;
    }) => {
      const reduce = isReduction(inv.type, inv.documentType);
      const isSaleDir = inv.type === "sale";
      const debit = (isSaleDir && !reduce) || (!isSaleDir && reduce) ? inv.totalAmount : "0";
      return {
        date: inv.date,
        type: "invoice" as const,
        number: inv.invoiceNumber,
        description:
          DOC_LABELS[inv.documentType] ||
          (inv.type === "sale" ? "Sale Invoice" : "Purchase Invoice"),
        debit,
        credit: debit === "0" ? inv.totalAmount : "0",
      };
    }),
    ...partyPayments.map((pmt: {
      date: Date;
      paymentNumber: string | null;
      amount: string;
      mode: string;
      settledType: string | null;
      legacySettledType: string | null;
    }) => {
      // Settling a purchase invoice = money OUT (debit). Settling a sale invoice
      // = money IN (credit). Fall back to the party's type only when the payment
      // is not tied to any invoice.
      const settled = pmt.settledType ?? pmt.legacySettledType;
      const isOutgoing = settled ? settled === "purchase" : party.type === "supplier";
      return {
        date: pmt.date,
        type: "payment" as const,
        number: pmt.paymentNumber ?? "",
        description: `Payment (${pmt.mode})`,
        debit: isOutgoing ? pmt.amount : "0",
        credit: isOutgoing ? "0" : pmt.amount,
      };
    }),
  ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  let runningBalance = party.openingBalance;
  const entriesWithBalance: LedgerEntry[] = entries.map((e) => {
    runningBalance = money.add(money.sub(runningBalance, e.credit), e.debit);
    return { ...e, runningBalance };
  });

  const totalDebit = money.sum(entries.map((e) => e.debit));
  const totalCredit = money.sum(entries.map((e) => e.credit));
  const closingBalance = money.add(money.sub(party.openingBalance, totalCredit), totalDebit);

  // UPI QR when the customer owes money — lets them settle from the PDF.
  let upiQrDataUrl: string | undefined;
  let upiPayUrl: string | undefined;
  // UPI QR whenever the party owes money (debit balance) — the declared type is
  // irrelevant: a dual-role contact with a debit balance also owes us.
  if (parseFloat(closingBalance) > 0) {
    const accounts = await db.select().from(bankAccounts).where(eq(bankAccounts.businessId, businessId));
    const upiAccount = accounts.find((a: { accountType: string }) => a.accountType === "upi");
    const upiId = upiAccount?.accountNumber;
    if (upiId && biz) {
      const deepLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(biz.name)}&am=${parseFloat(closingBalance).toFixed(2)}&cu=INR&tn=${encodeURIComponent(`Outstanding - ${party.name}`)}`;
      upiQrDataUrl = await QRCode.toDataURL(deepLink, { width: 200, margin: 1 });
      // Plain UPI deep link (no API origin available in this context).
      upiPayUrl = deepLink;
    }
  }

  const pdfBuffer = await generateLedgerPDF({
    businessName: biz?.name ?? "Business",
    partyName: party.name,
    partyType: party.type,
    openingBalance: party.openingBalance,
    fromDate: fromDate ? fromDate.toISOString() : null,
    toDate: toDate ? toDate.toISOString() : null,
    entries: entriesWithBalance,
    summary: { totalDebit, totalCredit, closingBalance },
    upiQrDataUrl,
    upiPayUrl,
  });

  const safeName = party.name.replace(/[^a-zA-Z0-9_-]/g, "_");

  return {
    pdfBuffer,
    fileName: `ledger-${safeName}.pdf`,
    partyName: party.name,
    partyEmail: party.email ?? null,
    partyPhone: party.phone ?? null,
    closingBalance,
  };
}
