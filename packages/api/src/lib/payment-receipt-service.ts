/**
 * payment-receipt-service.ts — builds a payment receipt PDF from live data.
 *
 * WHY THIS FILE EXISTS:
 * Three callers need the exact same receipt: the HTTP download route
 * (`GET /api/payments/:id/receipt.pdf`), the `payment.sendEmail` mutation and
 * the `payment.sendWhatsApp` mutation. Duplicating the joins in each place
 * would let them drift, so the query + mapping lives here once.
 */

import { eq, and } from "drizzle-orm";
import { payments, paymentAllocations, invoices, parties, businesses } from "@hisaabo/db";
import { generatePaymentReceiptPDF, type PaymentReceiptPDFData, type ReceiptAllocation } from "./payment-receipt-pdf.js";

export interface PaymentReceiptBundle {
  pdfBuffer: Buffer;
  fileName: string;
  paymentNumber: string;
  /** Party email, when the party record has one. */
  partyEmail: string | null;
  /** Party phone, when the party record has one. */
  partyPhone: string | null;
  partyName: string;
}

/**
 * Load a payment and render its receipt/voucher PDF.
 *
 * @param db          Tenant database handle (drizzle instance).
 * @param businessId  Business the payment must belong to (cross-tenant guard).
 * @param paymentId   Payment UUID.
 * @returns `null` when the payment does not exist in this business.
 */
export async function buildPaymentReceipt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  businessId: string,
  paymentId: string,
): Promise<PaymentReceiptBundle | null> {
  const [payment] = await db
    .select({
      id: payments.id,
      paymentNumber: payments.paymentNumber,
      amount: payments.amount,
      discount: payments.discount,
      mode: payments.mode,
      paymentDate: payments.paymentDate,
      referenceNumber: payments.referenceNumber,
      notes: payments.notes,
      invoiceId: payments.invoiceId,
      partyId: payments.partyId,
      partyName: parties.name,
      partyPhone: parties.phone,
      partyEmail: parties.email,
      partyGstin: parties.gstin,
      partyType: parties.type,
    })
    .from(payments)
    .innerJoin(parties, eq(parties.id, payments.partyId))
    .where(and(eq(payments.id, paymentId), eq(payments.businessId, businessId)))
    .limit(1);

  if (!payment) return null;

  const [biz] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);

  // Allocations table is authoritative; fall back to the legacy single invoice_id.
  const allocations = await db
    .select({
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      totalAmount: invoices.totalAmount,
      allocatedAmount: paymentAllocations.amount,
      status: invoices.status,
      // Drives receipt vs voucher — see below.
      invoiceType: invoices.type,
    })
    .from(paymentAllocations)
    .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
    .where(eq(paymentAllocations.paymentId, paymentId));

  let allocatedInvoices: ReceiptAllocation[] = allocations;

  if (allocatedInvoices.length === 0 && payment.invoiceId) {
    const [inv] = await db
      .select({
        invoiceNumber: invoices.invoiceNumber,
        invoiceDate: invoices.invoiceDate,
        totalAmount: invoices.totalAmount,
        status: invoices.status,
        invoiceType: invoices.type,
      })
      .from(invoices)
      .where(and(eq(invoices.id, payment.invoiceId), eq(invoices.businessId, businessId)))
      .limit(1);
    if (inv) {
      allocatedInvoices = [{ ...inv, allocatedAmount: payment.amount }];
    }
  }

  // Money in is a Receipt; money out is a Voucher. Decide from the invoice the
  // payment settled, NOT the party's declared type — a contact can be both a
  // customer and a supplier, and would otherwise get the wrong document title.
  const settledType = allocatedInvoices.find((a) => a.invoiceType)?.invoiceType ?? null;
  const isMoneyIn = settledType ? settledType === "sale" : payment.partyType === "customer";

  const pdfData: PaymentReceiptPDFData = {
    businessName: biz?.name ?? "Business",
    businessGstin: biz?.gstin ?? null,
    businessAddress: biz?.address ?? null,
    businessCity: biz?.city ?? null,
    businessPhone: biz?.phone ?? null,
    partyName: payment.partyName,
    partyPhone: payment.partyPhone,
    partyGstin: payment.partyGstin,
    paymentNumber: payment.paymentNumber ?? payment.id,
    paymentDate: payment.paymentDate,
    amount: payment.amount,
    discount: payment.discount ?? "0",
    mode: payment.mode,
    referenceNumber: payment.referenceNumber,
    notes: payment.notes,
    allocatedInvoices,
    // Money in from a customer is a Receipt; money out to a supplier is a Voucher.
    // Decided from the settled invoice so a dual-role contact is labelled right.
    direction: isMoneyIn ? "receipt" : "voucher",
  };

  const pdfBuffer = await generatePaymentReceiptPDF(pdfData);
  const safeNumber = (payment.paymentNumber ?? payment.id).replace(/[^a-zA-Z0-9_-]/g, "_");

  return {
    pdfBuffer,
    fileName: `${pdfData.direction}-${safeNumber}.pdf`,
    paymentNumber: payment.paymentNumber ?? payment.id,
    partyEmail: payment.partyEmail ?? null,
    partyPhone: payment.partyPhone ?? null,
    partyName: payment.partyName,
  };
}
