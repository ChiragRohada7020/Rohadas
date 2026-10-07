/**
 * Invoice PDF generation service.
 *
 * Extracts the data-assembly + PDF rendering logic that was previously
 * inlined in server.ts so it can be reused from both the HTTP PDF route
 * and the WhatsApp router.
 */

import { eq, and, inArray } from "drizzle-orm";
import { invoices, invoiceItems, items, parties, businesses, bankAccounts } from "@hisaabo/db";
import type { TenantDatabase } from "@hisaabo/db";
import { generateInvoicePDF, type InvoicePDFData, type PDFFormat, type InvoiceTemplate } from "./invoice-pdf.js";
import QRCode from "qrcode";

/**
 * Assemble `InvoicePDFData` from the database for a given invoice,
 * then render it to a PDF buffer.
 *
 * This mirrors the data-fetching logic in server.ts:439-583 but runs
 * the PDF generation in-process (no worker thread) since WhatsApp sends
 * are not latency-sensitive at the volume we expect.
 */
export async function generateInvoicePDFForSend(
  db: TenantDatabase,
  invoiceId: string,
  businessId: string,
  format: PDFFormat = "a5",
  apiBase?: string,
): Promise<Buffer> {
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.businessId, businessId)))
    .limit(1);

  if (!invoice) {
    throw new Error("Invoice not found");
  }

  const [party] = await db
    .select()
    .from(parties)
    .where(eq(parties.id, invoice.partyId))
    .limit(1);

  const [biz] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);

  if (!biz) {
    throw new Error("Business not found");
  }

  const lineItems = await db
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .orderBy(invoiceItems.sortOrder);

  // Fetch HSN codes and base units for linked items.
  // Historical join — intentionally no `isNull(items.deletedAt)` filter.
  const itemIds = lineItems.map((li) => li.itemId).filter(Boolean) as string[];
  const itemMeta =
    itemIds.length > 0
      ? await db
          .select({ id: items.id, hsn: items.hsn, unit: items.unit })
          .from(items)
          .where(inArray(items.id, itemIds))
      : [];

  const hsnMap = new Map(itemMeta.map((i) => [i.id, i.hsn || ""]));
  const itemUnitMap = new Map(itemMeta.map((i) => [i.id, i.unit]));

  // Fetch bank accounts for payment info on invoice
  const bizBankAccounts = await db
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.businessId, businessId))
    .orderBy(bankAccounts.isDefault);

  const upiAccount = bizBankAccounts.find((a) => a.accountType === "upi");
  const bankAccount =
    bizBankAccounts.find((a) => a.accountType === "savings" || a.accountType === "current") ||
    bizBankAccounts.find((a) => a.isDefault);

  // Generate UPI QR code if UPI account exists and invoice is a sale with remaining balance
  let upiQrDataUrl: string | undefined;
  let upiPayUrl: string | undefined;
  const upiId = upiAccount?.accountNumber;
  if (upiId && invoice.type === "sale") {
    const balance = parseFloat(invoice.totalAmount) - parseFloat(invoice.amountPaid);
    if (balance > 0) {
      const upiDeepLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(biz.name)}&am=${balance.toFixed(2)}&cu=INR&tn=${encodeURIComponent(invoice.invoiceNumber)}`;
      upiQrDataUrl = await QRCode.toDataURL(upiDeepLink, { width: 200, margin: 1 });
      const base = apiBase || process.env.APP_URL || "";
      upiPayUrl = `${base}/pay/upi?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(biz.name)}&am=${balance.toFixed(2)}&tn=${encodeURIComponent(invoice.invoiceNumber)}`;
    }
  }

  const pdfData: InvoicePDFData = {
    businessName: biz.name,
    businessLegalName: biz.legalName || undefined,
    businessGstin: biz.gstin || undefined,
    businessPan: biz.pan || undefined,
    businessPhone: biz.phone || undefined,
    businessEmail: biz.email || undefined,
    businessAddress: biz.address || undefined,
    businessCity: biz.city || undefined,
    businessState: biz.state || undefined,
    businessPincode: biz.pincode || undefined,
    partyName: party?.name ?? "—",
    partyPhone: party?.phone || undefined,
    partyEmail: party?.email || undefined,
    partyGstin: party?.gstin || undefined,
    partyBillingAddress: party?.billingAddress || undefined,
    partyCity: party?.city || undefined,
    partyState: party?.state || undefined,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate.toISOString(),
    dueDate: invoice.dueDate?.toISOString(),
    type: invoice.type,
    lineItems: lineItems.map((li) => ({
      itemName: li.itemName,
      description: li.description,
      quantity: li.quantity,
      unit: li.selectedUnit || (li.itemId ? itemUnitMap.get(li.itemId) : undefined) || undefined,
      unitPrice: li.unitPrice,
      taxPercent: li.taxPercent,
      taxAmount: li.taxAmount,
      discountPercent: li.discountPercent,
      totalAmount: li.totalAmount,
    })),
    subtotal: invoice.subtotal,
    taxAmount: invoice.taxAmount,
    discountAmount: invoice.discountAmount,
    totalAmount: invoice.totalAmount,
    amountPaid: invoice.amountPaid,
    notes: invoice.notes || undefined,
    termsAndConditions: invoice.termsAndConditions || undefined,
    bankAccountName: bankAccount?.accountName || undefined,
    bankAccountNumber: bankAccount?.accountNumber || undefined,
    bankIfsc: bankAccount?.ifsc || undefined,
    bankName: bankAccount?.bankName || undefined,
    upiId: upiId || undefined,
    upiQrDataUrl,
    upiPayUrl,
    gstRegistrationType: biz.gstRegistrationType || "unregistered",
    businessStateCode: biz.stateCode || undefined,
    partyStateCode: party?.stateCode || undefined,
    lineItemHsn: lineItems.map((li) => (li.itemId ? hsnMap.get(li.itemId) || "" : "")),
    isPaidPlan: true,
    status: invoice.status,
    logoBuffer: biz.logoData ?? undefined,
  };

  // Generate PDF in-process (no worker thread — WhatsApp sends are not latency-sensitive)
  const doc = generateInvoicePDF(pdfData, format, biz.invoiceTemplate as InvoiceTemplate);
  const chunks: Buffer[] = [];

  return await new Promise((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
