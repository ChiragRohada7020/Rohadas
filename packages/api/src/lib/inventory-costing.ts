/**
 * Periodic inventory costing and Cost of Goods Sold.
 *
 * COGS = Opening Inventory + Purchases(at cost) − Closing Inventory.
 *
 * Lines are valued at `items.purchasePrice` (weighted-average approximation —
 * the app stores a single current cost, no cost layers). `items.stockQuantity`
 * is only ever the CURRENT quantity, so movements (purchase +, sale/credit-note
 * −, adjustments ±) are period-bounded and used to back out opening stock from
 * closing stock.
 */

import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { invoices, invoiceItems, items, itemVariants, stockAdjustments } from "@hisaabo/db";
import type { TenantDatabase } from "@hisaabo/db";
import { money } from "@hisaabo/shared";
import { buildBusinessDateFilter } from "./business-date.js";

export interface InventoryCosting {
  openingInventory: string;
  closingInventory: string;
  purchasesAtCost: string;
  cogs: string;
  costingMethod: "weighted_average_current_cost";
  stockDataIncomplete: boolean;
}

const ZERO = "0.00";

/** Value of one unit of stock at cost. Guards against negative/NaN prices. */
function unitCost(purchasePrice: string | null | undefined): number {
  const n = parseFloat(purchasePrice ?? "0");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function computeInventoryAndCogs(
  db: TenantDatabase,
  businessId: string,
  fromDate?: Date,
  toDate?: Date,
): Promise<InventoryCosting> {
  // ── 1. Current stock + cost, for items and variants ───────────────────────
  const itemRows = await db
    .select({ id: items.id, stock: items.stockQuantity, cost: items.purchasePrice })
    .from(items)
    .where(and(eq(items.businessId, businessId), isNull(items.deletedAt)));

  const variantRows = await db
    .select({
      id: itemVariants.id,
      stock: itemVariants.stockQuantity,
      cost: itemVariants.purchasePrice,
      parentCost: items.purchasePrice,
    })
    .from(itemVariants)
    .innerJoin(items, eq(items.id, itemVariants.itemId))
    .where(and(eq(items.businessId, businessId), isNull(itemVariants.deletedAt), isNull(items.deletedAt)));

  const costByKey = new Map<string, number>();
  for (const r of itemRows) costByKey.set(`i:${r.id}`, unitCost(r.cost));
  // VARIANT COST FALLBACK: a variant with no cost of its own inherits the parent's.
  for (const r of variantRows) {
    costByKey.set(`v:${r.id}`, unitCost(r.cost) || unitCost(r.parentCost));
  }

  const currentStock = new Map<string, number>();
  for (const r of itemRows) currentStock.set(`i:${r.id}`, Math.max(parseFloat(r.stock ?? "0") || 0, 0));
  for (const r of variantRows) currentStock.set(`v:${r.id}`, Math.max(parseFloat(r.stock ?? "0") || 0, 0));

  // ── 2. Movements, valued at cost ──────────────────────────────────────────
  const periodInvoiceIds = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.businessId, businessId),
        isNull(invoices.deletedAt),
        sql`${invoices.status} NOT IN ('cancelled', 'draft')`,
        ...buildBusinessDateFilter(invoices, { from: fromDate, to: toDate }),
      ),
    );

  const ids = periodInvoiceIds.map((r) => r.id);
  let purchasesAtCost = 0;
  let saleValueOut = 0;
  const endTs = toDate ? toDate.getTime() : Date.now();

  if (ids.length > 0) {
    const lines = await db
      .select({
        invoiceType: invoices.type,
        docType: invoices.documentType,
        itemId: invoiceItems.itemId,
        variantId: invoiceItems.variantId,
        quantity: invoiceItems.quantity,
        unitPrice: invoiceItems.unitPrice,
        discountPercent: invoiceItems.discountPercent,
      })
      .from(invoiceItems)
      .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
      .where(inArray(invoiceItems.invoiceId, ids));

    for (const l of lines) {
      const key = l.variantId ? `v:${l.variantId}` : l.itemId ? `i:${l.itemId}` : null;
      if (!key) continue; // ad-hoc line with no catalog item — no cost basis
      const cost = costByKey.get(key) ?? 0;
      const qty = parseFloat(l.quantity ?? "0") || 0;

      const isPurchase = l.invoiceType === "purchase" && l.docType === "invoice";
      const isSale =
        l.invoiceType === "sale" &&
        (l.docType === "invoice" || l.docType === "credit_note" || l.docType === "sales_return");

      if (isPurchase) {
        const unit = parseFloat(l.unitPrice ?? "0") || 0;
        const disc = parseFloat(l.discountPercent ?? "0") || 0;
        const lineNet = qty * unit * (1 - disc / 100);
        purchasesAtCost += lineNet > 0 ? lineNet : qty * cost;
      } else if (isSale) {
        const signed = l.docType === "invoice" ? -qty : qty;
        saleValueOut += -signed * cost;
      }
    }
  }

  // ── 3. Stock adjustments, period-bounded ─────────────────────────────────
  // Adjustments are filtered to the SAME window as invoices. The previous
  // implementation only applied `<= endTs`, so every historical opening-stock
  // adjustment leaked into a narrow window ("Today", "Yesterday") and made
  // `netMovement` — and therefore COGS — wrong (typically negative → clamped
  // to ₹0). Only movements within the period can affect that window's COGS.
  const adjRows = await db
    .select({
      itemId: stockAdjustments.itemId,
      variantId: stockAdjustments.variantId,
      quantity: stockAdjustments.quantity,
    })
    .from(stockAdjustments)
    .innerJoin(items, eq(items.id, stockAdjustments.itemId))
    .where(
      and(
        eq(items.businessId, businessId),
        lte(stockAdjustments.adjustmentDate, new Date(endTs)),
        // drizzle `gte()` emits a properly bound parameter; a raw sql`` template
        // cannot bind a JS Date in postgres.js (ERR_INVALID_ARG_TYPE).
        fromDate ? gte(stockAdjustments.adjustmentDate, fromDate) : undefined,
      ),
    );

  let adjNet = 0;
  for (const a of adjRows) {
    const key = a.variantId ? `v:${a.variantId}` : `i:${a.itemId}`;
    const cost = costByKey.get(key) ?? 0;
    const qty = parseFloat(a.quantity ?? "0") || 0;
    adjNet += qty * cost;
  }

  // ── 4. Closing / opening valuation ────────────────────────────────────────
  let closing = 0;
  for (const [k, qty] of currentStock) {
    const cost = costByKey.get(k) ?? 0;
    closing += qty * cost;
  }

  // Opening = closing − net movements DURING the period. SIGN: purchases ADD
  // stock, sales REMOVE it, so net change is (purchases − sales + adjustments).
  const netMovement = purchasesAtCost - saleValueOut + adjNet;
  const opening = Math.max(closing - netMovement, 0);

  const openingStr = opening.toFixed(2);
  const closingStr = closing.toFixed(2);
  const purchasesStr = purchasesAtCost.toFixed(2);

  const hasCostData = costByKey.size > 0 && [...costByKey.values()].some((c) => c > 0);
  if (!hasCostData) {
    return {
      openingInventory: ZERO,
      closingInventory: ZERO,
      purchasesAtCost: purchasesStr,
      cogs: purchasesStr,
      costingMethod: "weighted_average_current_cost",
      stockDataIncomplete: true,
    };
  }

  const cogsRaw = money.sub(money.add(openingStr, purchasesStr), closingStr);
  const cogs = money.compare(cogsRaw, "0.00") < 0 ? "0.00" : cogsRaw;

  return {
    openingInventory: openingStr,
    closingInventory: closingStr,
    purchasesAtCost: purchasesStr,
    cogs,
    costingMethod: "weighted_average_current_cost",
    stockDataIncomplete: false,
  };
}

