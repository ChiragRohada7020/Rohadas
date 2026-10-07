import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { memberProcedure, router } from "../trpc.js";
import { AiAgent } from "../lib/aiAgent.js";

export const aiRouter = router({
  chat: memberProcedure
    .input(
      z.object({
        message: z.string().min(1),
        history: z.array(
          z.object({
            role: z.enum(["user", "assistant", "tool"]),
            content: z.string(),
            toolName: z.string().optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const agent = new AiAgent({
          user: ctx.user,
          tenantId: ctx.tenantId,
          db: ctx.db,
          businessId: ctx.businessId,
          ability: ctx.ability,
        });
        return await agent.chat(input.message, input.history);
      } catch (error: unknown) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "AI request failed",
        });
      }
    }),

  ocr: memberProcedure
    .input(
      z.object({
        imageData: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const agent = new AiAgent({
          user: ctx.user,
          tenantId: ctx.tenantId,
          db: ctx.db,
          businessId: ctx.businessId,
          ability: ctx.ability,
        });
        return await agent.ocrExtract(input.imageData);
      } catch (error: unknown) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "OCR processing failed",
        });
      }
    }),
});
