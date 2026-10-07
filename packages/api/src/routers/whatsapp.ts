import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { invoices, parties } from "@hisaabo/db";
import { router, memberProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { requireCan } from "../lib/permissions.js";
import { whatsAppService } from "../lib/whatsapp.js";
import { generateInvoicePDFForSend } from "../lib/invoice-pdf-service.js";

const phoneSchema = z.string().min(5).max(20);
const invoiceMessageSchema = z.string().max(1000).optional();

export const whatsAppRouter = router({
  getStatus: memberProcedure.query(async ({ ctx }) => {
    requireCan(ctx.ability, "read", "Invoice");

    const status = await whatsAppService.getStatus();
    return status;
  }),

  /**
   * Send an invoice as a PDF via WhatsApp to the party's saved phone number.
   * The PDF is generated server-side and sent directly to WhatsApp —
   * no client-side upload or external storage required.
   */
  sendInvoice: memberProcedure
    .input(
      z.object({
        invoiceId: z.string().uuid(),
        phoneNumber: phoneSchema.optional(),
        message: invoiceMessageSchema,
        format: z.enum(["a4", "a5", "thermal"]).default("a5"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "Invoice");

      // Fetch invoice to get the party's phone (unless overridden by client)
      const [invoice] = await ctx.db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          partyId: invoices.partyId,
          businessId: invoices.businessId,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.id, input.invoiceId),
            eq(invoices.businessId, ctx.businessId),
          ),
        )
        .limit(1);

      if (!invoice) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      }

      // Determine the recipient phone number
      let recipientPhone: string;
      if (input.phoneNumber) {
        recipientPhone = input.phoneNumber;
      } else {
        // Use the party's stored phone number
        const [party] = await ctx.db
          .select({ phone: parties.phone })
          .from(parties)
          .where(eq(parties.id, invoice.partyId))
          .limit(1);

        if (!party?.phone) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Party has no phone number. Please provide a phone number.",
          });
        }
        recipientPhone = party.phone;
      }

      // Generate the PDF buffer using the shared PDF service
      const pdfBuffer = await generateInvoicePDFForSend(
        ctx.db,
        invoice.id,
        invoice.businessId,
        input.format,
      );

      // Send via WhatsApp
      const result = await whatsAppService.sendInvoicePDF(recipientPhone, pdfBuffer, {
        invoiceNumber: invoice.invoiceNumber,
        message: input.message,
      });

      if (!result.success) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: result.error ?? "Failed to send WhatsApp message",
        });
      }

      return {
        success: true,
        messageId: result.messageId,
        recipient: recipientPhone,
        invoiceNumber: invoice.invoiceNumber,
      };
    }),

  reset: memberProcedure.mutation(async ({ ctx }) => {
    requireCan(ctx.ability, "read", "Invoice");
    await whatsAppService.reset();
    return { success: true };
  }),
});
