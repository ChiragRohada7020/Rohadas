/**
 * inventory.ts — godowns (stock locations) and stock lots (batch/serial/expiry).
 *
 * `items.stock_quantity` remains the authoritative business-wide total; stock_lots
 * is an additional per-lot / per-godown breakdown that sums back to it. Every
 * mutation updates both sides inside ONE transaction so they can never drift.
 */

import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql, sum } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  godowns,
  godownTransfers,
  items,
  itemVariants,
  stockLots,
  lotConsumptions,
} from "@hisaabo/db";
import { router, viewerProcedure } from "../trpc.js";
import { requireCan } from "../lib/permissions.js";
import {
  godownCreateSchema,
  godownIdSchema,
  godownSetPrimarySchema,
  godownTransferSchema,
  godownUpdateSchema,
  lotAllocateSchema,
  lotCreateSchema,
  lotListSchema,
} from "@hisaabo/shared";
import { toMilli, fromMilli, allocateLots } from "../lib/stock-movement.js";
import { getPrimaryGodownId } from "../lib/primary-godown.js";

type TrackingMode = "none" | "batch" | "serial" | "expiry";

/** Load an item/variant pair scoped to the business, for tracking decisions. */
async function loadTracking(
  tx: any,
  businessId: string,
  itemId: string,
  variantId?: string,
): Promise<{ itemId: string; variantId: string | null; trackingMode: TrackingMode }> {
  if (variantId) {
    const [v] = await tx
      .select({ id: itemVariants.id, trackingMode: itemVariants.trackingMode })
      .from(itemVariants)
      .where(and(eq(itemVariants.id, variantId), isNull(itemVariants.deletedAt)))
      .limit(1);
    if (v && v.trackingMode !== "none") {
      return { itemId, variantId: v.id, trackingMode: v.trackingMode as TrackingMode };
    }
  }

  const [i] = await tx
    .select({ id: items.id, trackingMode: items.trackingMode })
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.businessId, businessId)))
    .limit(1);
  if (!i) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found in this business" });
  return { itemId: i.id, variantId: null, trackingMode: (i.trackingMode ?? "none") as TrackingMode };
}

/** Assert a godown belongs to the business (throws otherwise). */
async function assertOwnedGodown(tx: any, businessId: string, godownId: string): Promise<void> {
  const [g] = await tx
    .select({ id: godowns.id })
    .from(godowns)
    .where(and(eq(godowns.id, godownId), eq(godowns.businessId, businessId), isNull(godowns.deletedAt)))
    .limit(1);
  if (!g) throw new TRPCError({ code: "NOT_FOUND", message: "Godown not found in this business" });
}

export const inventoryRouter = router({
  // ── Godowns ───────────────────────────────────────────────────────────────

  list: viewerProcedure.query(async ({ ctx }) => {
    requireCan(ctx.ability, "read", "Item");
    return ctx.db
      .select()
      .from(godowns)
      .where(and(eq(godowns.businessId, ctx.businessId), isNull(godowns.deletedAt)))
      .orderBy(desc(godowns.isPrimary), asc(godowns.name));
  }),

  create: viewerProcedure.input(godownCreateSchema).mutation(async ({ input, ctx }) => {
    requireCan(ctx.ability, "create", "Item");
    const existing = await ctx.db
      .select({ id: godowns.id })
      .from(godowns)
      .where(and(eq(godowns.businessId, ctx.businessId), isNull(godowns.deletedAt)));
    const makePrimary = input.isPrimary || existing.length === 0;

    return ctx.db.transaction(async (tx: any) => {
      if (makePrimary) {
        await tx
          .update(godowns)
          .set({ isPrimary: false, updatedAt: new Date() })
          .where(and(eq(godowns.businessId, ctx.businessId), eq(godowns.isPrimary, true)));
      }
      const [row] = await tx
        .insert(godowns)
        .values({
          businessId: ctx.businessId,
          name: input.name,
          code: input.code ?? null,
          address: input.address ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          stateCode: input.stateCode ?? null,
          pincode: input.pincode ?? null,
          phone: input.phone ?? null,
          isPrimary: makePrimary,
        })
        .returning();
      return row;
    });
  }),


  update: viewerProcedure.input(godownUpdateSchema).mutation(async ({ input, ctx }) => {
    requireCan(ctx.ability, "update", "Item");
    return ctx.db.transaction(async (tx: any) => {
      await assertOwnedGodown(tx, ctx.businessId, input.id);
      const [row] = await tx
        .update(godowns)
        .set({ ...input.data, updatedAt: new Date() })
        .where(and(eq(godowns.id, input.id), eq(godowns.businessId, ctx.businessId)))
        .returning();
      return row;
    });
  }),

  setPrimary: viewerProcedure.input(godownSetPrimarySchema).mutation(async ({ input, ctx }) => {
    requireCan(ctx.ability, "update", "Item");
    return ctx.db.transaction(async (tx: any) => {
      await assertOwnedGodown(tx, ctx.businessId, input.id);
      await tx
        .update(godowns)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(and(eq(godowns.businessId, ctx.businessId), eq(godowns.isPrimary, true)));
      await tx
        .update(godowns)
        .set({ isPrimary: true, updatedAt: new Date() })
        .where(and(eq(godowns.id, input.id), eq(godowns.businessId, ctx.businessId)));
      return { success: true };
    });
  }),

  delete: viewerProcedure.input(godownIdSchema).mutation(async ({ input, ctx }) => {
    requireCan(ctx.ability, "delete", "Item");
    return ctx.db.transaction(async (tx: any) => {
      await assertOwnedGodown(tx, ctx.businessId, input.id);

      const [{ held }] = await tx
        .select({ held: sql<string>`COALESCE(SUM(${stockLots.quantity}::numeric), 0)::text` })
        .from(stockLots)
        .where(and(eq(stockLots.godownId, input.id), eq(stockLots.businessId, ctx.businessId), gt(stockLots.quantity, "0"), isNull(stockLots.deletedAt)));
      if (parseFloat(held) > 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot delete a godown that still holds stock" });
      }

      await tx
        .update(godowns)
        .set({ deletedAt: new Date(), isPrimary: false, updatedAt: new Date() })
        .where(and(eq(godowns.id, input.id), eq(godowns.businessId, ctx.businessId)));

      const [primary] = await tx
        .select({ id: godowns.id })
        .from(godowns)
        .where(and(eq(godowns.businessId, ctx.businessId), eq(godowns.isPrimary, true), isNull(godowns.deletedAt)))
        .limit(1);
      if (!primary) {
        const [next] = await tx
          .select({ id: godowns.id })
          .from(godowns)
          .where(and(eq(godowns.businessId, ctx.businessId), isNull(godowns.deletedAt)))
          .orderBy(asc(godowns.name))
          .limit(1);
        if (next) {
          await tx
            .update(godowns)
            .set({ isPrimary: true, updatedAt: new Date() })
            .where(eq(godowns.id, next.id));
        }
      }

      return { success: true };
    });
  }),

  // ── Lots (list / breakdown / allocation) ──────────────────────────────────

  listLots: viewerProcedure.input(lotListSchema).query(async ({ input, ctx }) => {

    requireCan(ctx.ability, "read", "Item");
    return ctx.db
      .select()
      .from(stockLots)
      .where(and(
        eq(stockLots.businessId, ctx.businessId),
        input.itemId ? eq(stockLots.itemId, input.itemId) : undefined,
        input.variantId ? eq(stockLots.variantId, input.variantId) : undefined,
        input.godownId ? eq(stockLots.godownId, input.godownId) : undefined,
        input.batchNo ? eq(stockLots.batchNo, input.batchNo) : undefined,
        input.expiringBefore ? lte(stockLots.expiryDate, new Date(input.expiringBefore)) : undefined,
        input.inStockOnly ? gt(stockLots.quantity, "0") : undefined,
        isNull(stockLots.deletedAt),
      ))
      .orderBy(asc(stockLots.expiryDate))
      .limit(input.limit);
  }),


  stockByGodown: viewerProcedure
    .input(z.object({ itemId: z.string().uuid(), variantId: z.string().uuid().optional() }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "Item");

      const target = await loadTracking(ctx.db, ctx.businessId, input.itemId, input.variantId);

      const [headline] = target.variantId
        ? await ctx.db
            .select({ stockQuantity: itemVariants.stockQuantity })
            .from(itemVariants)
            .where(eq(itemVariants.id, target.variantId))
            .limit(1)
        : await ctx.db
            .select({ stockQuantity: items.stockQuantity })
            .from(items)
            .where(eq(items.id, target.itemId))
            .limit(1);

      const rows = await ctx.db
        .select({
          godownId: stockLots.godownId,
          godownName: godowns.name,
          godownCode: godowns.code,
          total: sum(stockLots.quantity),
        })
        .from(stockLots)
        .leftJoin(godowns, eq(godowns.id, stockLots.godownId))
        .where(and(
          eq(stockLots.businessId, ctx.businessId),
          eq(stockLots.itemId, target.itemId),
          target.variantId ? eq(stockLots.variantId, target.variantId) : isNull(stockLots.variantId),
          isNull(stockLots.deletedAt),
        ))
        .groupBy(stockLots.godownId, godowns.name, godowns.code);

      let allocated = 0;
      const breakdown = rows.map((r) => {
        const qty = toMilli(r.total);
        allocated += qty;
        return {
          godownId: r.godownId,
          godownName: r.godownName ?? "Unassigned godown",
          godownCode: r.godownCode ?? null,
          quantity: fromMilli(qty),
        };
      });

      const totalMilli = toMilli(headline?.stockQuantity ?? null);

      return {
        itemId: target.itemId,
        variantId: target.variantId,
        trackingMode: target.trackingMode,
        totalQuantity: fromMilli(totalMilli),
        breakdown,
        unattributed: fromMilli(totalMilli - allocated),
      };
    }),

  allocateFEFO: viewerProcedure.input(lotAllocateSchema).query(async ({ input, ctx }) => {
    requireCan(ctx.ability, "read", "Item");

    const requested = toMilli(input.quantity);
    const plan = await allocateLots(ctx.db, ctx.businessId, {
      itemId: input.itemId,
      variantId: input.variantId,
      godownId: input.godownId,
      lotId: input.lotId,
      quantityMilli: requested,
    });

    const lotIds = plan.map((a) => a.lotId);
    const lots = lotIds.length
      ? await ctx.db
          .select({
            id: stockLots.id,
            batchNo: stockLots.batchNo,
            serialNo: stockLots.serialNo,
            expiryDate: stockLots.expiryDate,
            quantity: stockLots.quantity,
          })
          .from(stockLots)
          .where(inArray(stockLots.id, lotIds))
      : [];
    const byId = new Map(lots.map((l) => [l.id, l]));

    const enriched = plan.map((a) => {
      const lot = byId.get(a.lotId);
      return {
        lotId: a.lotId,
        batchNo: lot?.batchNo ?? null,
        serialNo: lot?.serialNo ?? null,
        expiryDate: lot?.expiryDate ? lot.expiryDate.toISOString() : null,
        allocate: a.quantity,
        available: lot?.quantity ?? a.quantity,
      };
    });

    const covered = plan.reduce((s, a) => s + toMilli(a.quantity), 0);

    return { plan: enriched, shortfall: fromMilli(requested - covered) };
  }),

  createLot: viewerProcedure.input(lotCreateSchema).mutation(async ({ input, ctx }) => {
    requireCan(ctx.ability, "create", "Item");
    return ctx.db.transaction(async (tx: any) => {
      const target = await loadTracking(tx, ctx.businessId, input.itemId, input.variantId);
      if (target.trackingMode === "none") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This item does not use lot tracking" });
      }
      if (target.trackingMode === "serial") {
        if (!input.serialNo) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Serial number is required for serial-tracked items" });
        }
        if (parseFloat(input.quantity) !== 1) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Serial units are quantity exactly 1" });
        }
        const [dup] = await tx
          .select({ id: stockLots.id })
          .from(stockLots)
          .where(and(eq(stockLots.businessId, ctx.businessId), eq(stockLots.serialNo, input.serialNo!), isNull(stockLots.deletedAt)))
          .limit(1);
        if (dup) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Serial number ${input.serialNo} is already recorded on another lot` });
        }
      }
      if (target.trackingMode === "expiry" && !input.expiryDate) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Expiry date is required for expiry-tracked items" });
      }
      if (input.expiryDate && input.manufacturingDate && new Date(input.expiryDate) <= new Date(input.manufacturingDate)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Expiry date must be after the manufacturing date" });
      }

      const primaryGodown = await getPrimaryGodownId(tx, ctx.businessId);
      const [lot] = await tx
        .insert(stockLots)
        .values({
          businessId: ctx.businessId,
          itemId: target.itemId,
          variantId: target.variantId,
          godownId: input.godownId ?? primaryGodown,
          batchNo: input.batchNo ?? null,
          serialNo: input.serialNo ?? null,
          manufacturingDate: input.manufacturingDate ? new Date(input.manufacturingDate) : null,
          expiryDate: input.expiryDate ? new Date(input.expiryDate) : null,
          quantity: input.quantity,
          quantityReceived: input.quantity,
          quantitySold: "0.000",
          unitCost: input.unitCost ?? null,
          status: "active",
        })
        .returning();

      if (target.variantId) {
        await tx
          .update(itemVariants)
          .set({ stockQuantity: sql`${itemVariants.stockQuantity}::numeric + ${input.quantity}::numeric`, updatedAt: new Date() })
          .where(eq(itemVariants.id, target.variantId));
      } else {
        await tx
          .update(items)
          .set({ stockQuantity: sql`${items.stockQuantity}::numeric + ${input.quantity}::numeric`, updatedAt: new Date() })
          .where(eq(items.id, target.itemId));
      }

      return lot;
    });
  }),

  transfer: viewerProcedure.input(godownTransferSchema).mutation(async ({ input, ctx }) => {
    requireCan(ctx.ability, "update", "Item");
    return ctx.db.transaction((tx: any) =>
      performTransfer(tx, ctx.businessId, ctx.user.id, ctx.user.name ?? undefined, input),
    );
  }),

  expiringSoon: viewerProcedure
    .input(z.object({
      withinDays: z.number().int().min(1).max(365).default(30),
      limit: z.number().int().min(1).max(200).default(200),
    }))
    .query(async ({ input, ctx }) => {
      requireCan(ctx.ability, "read", "Item");
      const now = new Date();
      const horizon = new Date(now.getTime() + input.withinDays * 86400000);

      const lots = await ctx.db
        .select({
          id: stockLots.id,
          itemName: items.name,
          batchNo: stockLots.batchNo,
          serialNo: stockLots.serialNo,
          quantity: stockLots.quantity,
          godownName: godowns.name,
          expiryDate: stockLots.expiryDate,
        })
        .from(stockLots)
        .innerJoin(items, eq(items.id, stockLots.itemId))
        .leftJoin(godowns, eq(godowns.id, stockLots.godownId))
        .where(and(
          eq(stockLots.businessId, ctx.businessId),
          isNull(stockLots.deletedAt),
          gt(stockLots.quantity, "0"),
          sql`${stockLots.expiryDate} IS NOT NULL`,
          lte(stockLots.expiryDate, horizon),
        ))
        .orderBy(asc(stockLots.expiryDate))
        .limit(input.limit);

      const MS_PER_DAY = 86400000;
      return lots.map((l) => {
        const exp = l.expiryDate;
        const daysRemaining = exp ? Math.ceil((exp.getTime() - now.getTime()) / MS_PER_DAY) : null;
        return {
          id: l.id,
          itemName: l.itemName,
          batchNo: l.batchNo ?? l.serialNo,
          quantity: l.quantity,
          godownName: l.godownName ?? null,
          expiryDate: exp,
          daysRemaining,
          alreadyExpired: exp ? exp.getTime() < now.getTime() : false,
        };
      });
    }),

});


/**
 * Move stock between godowns. Does not change the business-wide total — it
 * re-attributes quantity from one godown to another, so items.stock_quantity is
 * neither read nor written here. Only lot balances move. Works for tracked and
 * untracked items alike (an untracked item moves its nameless bucket).
 */
async function performTransfer(
  tx: any,
  businessId: string,
  userId: string | undefined,
  userName: string | undefined,
  input: {
    itemId: string;
    variantId?: string;
    quantity: string;
    fromGodownId?: string;
    toGodownId: string;
    transferDate?: string;
    referenceNumber?: string;
    notes?: string;
  },
) {
  const moveMilli = toMilli(input.quantity);
  if (moveMilli <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Transfer quantity must be greater than zero" });
  }

  await assertOwnedGodown(tx, businessId, input.toGodownId);
  if (input.fromGodownId) {
    if (input.fromGodownId === input.toGodownId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Source and destination godown are the same" });
    }
    await assertOwnedGodown(tx, businessId, input.fromGodownId);
  }

  const target = await loadTracking(tx, businessId, input.itemId, input.variantId);
  const lotScope = target.variantId
    ? eq(stockLots.variantId, target.variantId)
    : isNull(stockLots.variantId);

  let source: { id: string; batchNo: string | null; serialNo: string | null } | undefined;

  if (input.fromGodownId) {
    const [found] = await tx
      .select({ id: stockLots.id, batchNo: stockLots.batchNo, serialNo: stockLots.serialNo, quantity: stockLots.quantity })
      .from(stockLots)
      .where(and(
        eq(stockLots.businessId, businessId),
        eq(stockLots.itemId, target.itemId),
        eq(stockLots.godownId, input.fromGodownId),
        lotScope,
        isNull(stockLots.deletedAt),
        gt(stockLots.quantity, "0"),
      ))
      .orderBy(asc(stockLots.expiryDate))
      .limit(1)
      .for("update");

    if (!found) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "No stock of this item in the source godown" });
    }
    if (toMilli(found.quantity) < moveMilli) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Source godown holds only ${found.quantity}, less than the requested ${input.quantity}`,
      });
    }

    await tx
      .update(stockLots)
      .set({
        quantity: sql`(${stockLots.quantity}::numeric - ${fromMilli(moveMilli)}::numeric)`,
        updatedAt: new Date(),
      })
      .where(eq(stockLots.id, found.id));

    source = { id: found.id, batchNo: found.batchNo, serialNo: found.serialNo };
  }

  const [existingDestination] = await tx
    .select({ id: stockLots.id })
    .from(stockLots)
    .where(and(
      eq(stockLots.businessId, businessId),
      eq(stockLots.itemId, target.itemId),
      eq(stockLots.godownId, input.toGodownId),
      lotScope,
      isNull(stockLots.deletedAt),
    ))
    .limit(1);

  if (existingDestination) {
    await tx
      .update(stockLots)
      .set({
        quantity: sql`(${stockLots.quantity}::numeric + ${fromMilli(moveMilli)}::numeric)`,
        updatedAt: new Date(),
      })
      .where(eq(stockLots.id, existingDestination.id));
  } else {
    await tx.insert(stockLots).values({
      businessId,
      itemId: target.itemId,
      variantId: target.variantId,
      godownId: input.toGodownId,
      batchNo: source?.batchNo ?? null,
      serialNo: source?.serialNo ?? null,
      quantity: fromMilli(moveMilli),
      quantityReceived: fromMilli(moveMilli),
      quantitySold: "0.000",
      status: "active",
    });
  }

  const [transfer] = await tx
    .insert(godownTransfers)
    .values({
      businessId,
      itemId: target.itemId,
      variantId: target.variantId,
      fromGodownId: input.fromGodownId ?? null,
      toGodownId: input.toGodownId,
      quantity: fromMilli(moveMilli),
      status: "completed",
      transferDate: input.transferDate ? new Date(input.transferDate) : new Date(),
      referenceNumber: input.referenceNumber ?? null,
      notes: input.notes ?? null,
      createdByUserId: userId,
      createdByName: userName,
    })
    .returning();

  return { ...transfer, quantity: fromMilli(moveMilli) };
}
