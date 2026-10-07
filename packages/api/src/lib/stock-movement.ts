/**
 * stock-movement.ts — lot-aware stock movements for business documents.
 *
 * The document routers move `items.stock_quantity ± quantity`. This module keeps
 * the SECOND ledger (stock_lots) that makes per-godown / per-lot stock
 * answerable. Every function runs inside a transaction that has ALREADY updated
 * the item total, moving the same quantity in the same direction, so the two
 * ledgers agree or the whole document rolls back.
 *
 * Lot identity (batch/serial/expiry) applies only to tracked items; an untracked
 * item still moves a nameless per-godown quantity bucket.
 */

import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { items, itemVariants, stockLots, lotConsumptions } from "@hisaabo/db";

/** Parse a numeric(15,3) string into integer milli-units. */
export function toMilli(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : parseFloat(value ?? "0");
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000);
}

/** Render integer milli-units back as a fixed 3-decimal numeric string. */
export function fromMilli(milli: number): string {
  return (milli / 1000).toFixed(3);
}

/** One line of a business document, as the movement engine needs to see it. */
export interface MovementLine {
  invoiceItemId: string;
  itemId: string | null;
  variantId: string | null;
  quantity: string;
  conversionFactor?: string | null;
  godownId?: string | null;
  lotId?: string | null;
  batchNo?: string | null;
  serialNo?: string | null;
  expiryDate?: string | null;
}

export interface MovementContext {
  businessId: string;
  /** +1 receives stock, -1 draws it out. */
  direction: 1 | -1;
  /** The godown to use when a line does not name one. */
  defaultGodownId: string | null;
}

/** A lot selected by FEFO allocation, with how much it contributes. */
export interface Allocation {
  lotId: string;
  quantity: string;
  godownId: string | null;
}

/**
 * Resolve whether an item/variant is lot-tracked. A variant is tracked when it
 * declares its own non-"none" mode, otherwise it inherits the parent item's.
 */
export async function resolveTrackingMode(
  tx: any,
  businessId: string,
  itemId: string | null,
  variantId: string | null,
): Promise<"none" | "batch" | "serial" | "expiry"> {
  if (!itemId) return "none";

  if (variantId) {
    const [v] = await tx
      .select({ trackingMode: itemVariants.trackingMode })
      .from(itemVariants)
      .where(and(eq(itemVariants.id, variantId), isNull(itemVariants.deletedAt)))
      .limit(1);
    if (v && v.trackingMode !== "none") return v.trackingMode;
  }

  const [i] = await tx
    .select({ trackingMode: items.trackingMode })
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.businessId, businessId)))
    .limit(1);

  return (i?.trackingMode ?? "none") as "none" | "batch" | "serial" | "expiry";
}

/**
 * Pick the lots a stock-out should draw from, earliest expiry first (FEFO).
 * Does not mutate anything. `lotId` pins a specific unit; otherwise every active
 * lot for the item/variant (optionally one godown) with quantity > 0, ordered by
 * expiry ascending, locked FOR UPDATE so two tills cannot double-sell a batch.
 */
export async function allocateLots(
  tx: any,
  businessId: string,
  params: {
    itemId: string;
    variantId?: string | null;
    godownId?: string | null;
    lotId?: string | null;
    quantityMilli: number;
  },
): Promise<Allocation[]> {
  const { itemId, variantId, godownId, lotId, quantityMilli } = params;
  if (quantityMilli <= 0) return [];

  const variantScope = variantId ? eq(stockLots.variantId, variantId) : isNull(stockLots.variantId);

  if (lotId) {
    const [pinned] = await tx
      .select({ id: stockLots.id, quantity: stockLots.quantity, godownId: stockLots.godownId })
      .from(stockLots)
      .where(and(
        eq(stockLots.businessId, businessId),
        eq(stockLots.itemId, itemId),
        eq(stockLots.id, lotId),
        variantScope,
        isNull(stockLots.deletedAt),
      ))
      .limit(1)
      .for("update");

    if (!pinned) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "The selected lot does not exist" });
    }
    if (toMilli(pinned.quantity) < quantityMilli) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Lot has only ${pinned.quantity} left, less than the ${fromMilli(quantityMilli)} being sold`,
      });
    }
    return [{ lotId: pinned.id, quantity: fromMilli(quantityMilli), godownId: pinned.godownId }];
  }

  const candidates = await tx
    .select({ id: stockLots.id, quantity: stockLots.quantity, godownId: stockLots.godownId })
    .from(stockLots)
    .where(and(
      eq(stockLots.businessId, businessId),
      eq(stockLots.itemId, itemId),
      variantScope,
      godownId ? eq(stockLots.godownId, godownId) : undefined,
      eq(stockLots.status, "active"),
      gt(stockLots.quantity, "0"),
      isNull(stockLots.deletedAt),
    ))
    .orderBy(asc(stockLots.expiryDate))
    .for("update");

  const plan: Allocation[] = [];
  let remaining = quantityMilli;
  for (const lot of candidates) {
    if (remaining <= 0) break;
    const available = toMilli(lot.quantity);
    const take = Math.min(available, remaining);
    if (take <= 0) continue;
    plan.push({ lotId: lot.id, quantity: fromMilli(take), godownId: lot.godownId });
    remaining -= take;
  }

  return plan;
}

/**
 * Apply lot-ledger movements for a set of document lines.
 *
 * Call this INSIDE the same transaction that has already updated
 * items.stock_quantity, with the matching `direction`. Every line moves a
 * per-godown bucket: a tracked line carries its batch/serial identity, an
 * untracked line moves the nameless quantity bucket. Item totals are owned by
 * the caller and are untouched here.
 */
export async function applyLineMovements(
  tx: any,
  ctx: MovementContext,
  lines: MovementLine[],
): Promise<void> {
  for (const line of lines) {
    if (!line.itemId) continue;

    // Stock is held in BASE units, so a line sold in a larger unit (a dozen, a
    // kg) must be converted before it touches the ledger.
    const factor = parseFloat(line.conversionFactor || "1");
    const qtyMilli = Math.round(toMilli(line.quantity) * factor);
    if (qtyMilli === 0) continue;

    if (ctx.direction === -1) {
      await drawFromLots(tx, ctx, line, qtyMilli);
    } else {
      await addToLot(tx, ctx, line, qtyMilli);
    }
  }
}

/**
 * Stock-out: allocate FEFO across lots and record what was taken. A
 * `lot_consumptions` row with a NULL lot_id means "this quantity could not be
 * covered by any lot" — the backorder case the stock model deliberately permits.
 */
async function drawFromLots(
  tx: any,
  ctx: MovementContext,
  line: MovementLine,
  qtyMilli: number,
): Promise<void> {
  const plan = await allocateLots(tx, ctx.businessId, {
    itemId: line.itemId!,
    variantId: line.variantId,
    godownId: line.godownId ?? null,
    lotId: line.lotId ?? null,
    quantityMilli: qtyMilli,
  });

  const covered = plan.reduce((sum, a) => sum + toMilli(a.quantity), 0);

  if (covered < qtyMilli) {
    await tx.insert(lotConsumptions).values({
      businessId: ctx.businessId,
      invoiceItemId: line.invoiceItemId,
      lotId: null,
      quantity: fromMilli(qtyMilli - covered),
    });
  }

  for (const allocation of plan) {
    await tx
      .update(stockLots)
      .set({
        quantity: sql`(${stockLots.quantity}::numeric - ${allocation.quantity}::numeric)`,
        quantitySold: sql`(${stockLots.quantitySold}::numeric + ${allocation.quantity}::numeric)`,
        updatedAt: new Date(),
      })
      .where(eq(stockLots.id, allocation.lotId));

    await tx.insert(lotConsumptions).values({
      businessId: ctx.businessId,
      invoiceItemId: line.invoiceItemId,
      lotId: allocation.lotId,
      quantity: allocation.quantity,
    });
  }
}

/**
 * Stock-in: add to a lot in the target godown, opening one when needed.
 * Reuses an existing lot for the item/variant/godown rather than splitting a
 * quantity across two rows.
 */
async function addToLot(
  tx: any,
  ctx: MovementContext,
  line: MovementLine,
  qtyMilli: number,
): Promise<void> {
  const godownId = line.godownId ?? ctx.defaultGodownId;

  const [existing] = await tx
    .select({ id: stockLots.id })
    .from(stockLots)
    .where(and(
      eq(stockLots.businessId, ctx.businessId),
      eq(stockLots.itemId, line.itemId!),
      line.variantId ? eq(stockLots.variantId, line.variantId) : isNull(stockLots.variantId),
      godownId ? eq(stockLots.godownId, godownId) : isNull(stockLots.godownId),
      isNull(stockLots.deletedAt),
    ))
    .limit(1);

  if (existing) {
    await tx
      .update(stockLots)
      .set({
        quantity: sql`(${stockLots.quantity}::numeric + ${fromMilli(qtyMilli)}::numeric)`,
        quantityReceived: sql`(${stockLots.quantityReceived}::numeric + ${fromMilli(qtyMilli)}::numeric)`,
        updatedAt: new Date(),
      })
      .where(eq(stockLots.id, existing.id));
    return;
  }

  await tx.insert(stockLots).values({
    businessId: ctx.businessId,
    itemId: line.itemId!,
    variantId: line.variantId,
    godownId,
    batchNo: line.batchNo ?? null,
    serialNo: line.serialNo ?? null,
    expiryDate: line.expiryDate ? new Date(line.expiryDate) : null,
    quantity: fromMilli(qtyMilli),
    quantityReceived: fromMilli(qtyMilli),
    quantitySold: "0.000",
    status: "active",
  });
}

/**
 * Reverse a cancelled document's lot movements, reading `lot_consumptions` so
 * each lot gets back exactly what it gave. NULL-lot shortfalls have nothing to
 * give back to, so they are simply dropped.
 */
export async function reverseDocumentMovements(
  tx: any,
  businessId: string,
  invoiceId: string,
): Promise<void> {
  const { invoiceItems } = await import("@hisaabo/db");

  const lines = await tx
    .select({ id: invoiceItems.id })
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId));

  if (lines.length === 0) return;
  const lineIds = lines.map((l: { id: string }) => l.id);

  const consumptions = await tx
    .select({ id: lotConsumptions.id, lotId: lotConsumptions.lotId, quantity: lotConsumptions.quantity })
    .from(lotConsumptions)
    .where(inArray(lotConsumptions.invoiceItemId, lineIds));

  for (const c of consumptions) {
    if (!c.lotId) continue;
    await tx
      .update(stockLots)
      .set({
        quantity: sql`(${stockLots.quantity}::numeric + ${c.quantity}::numeric)`,
        quantitySold: sql`(${stockLots.quantitySold}::numeric - ${c.quantity}::numeric)`,
        updatedAt: new Date(),
      })
      .where(eq(stockLots.id, c.lotId));
  }

  if (consumptions.length > 0) {
    await tx.delete(lotConsumptions).where(inArray(lotConsumptions.invoiceItemId, lineIds));
  }
}

