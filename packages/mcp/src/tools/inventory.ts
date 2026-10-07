/**
 * inventory.ts — MCP tools for godowns and stock lots (batch/serial/expiry).
 *
 * WHY AN AGENT CARES ABOUT THIS: "how much of batch X is left and when does it
 * expire" and "how much stock is in my Pune branch" are the two questions the
 * single-scalar stock model could never answer. An agent handling a
 * replenishment or an expiry-risk question needs them directly.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RohadasClient } from "../client.js";
import { wrapTool } from "../lib/errors.js";

const json = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
});

export function registerInventoryTools(server: McpServer, client: RohadasClient): void {
  server.tool(
    "inventory_list_godowns",
    [
      "List the business's stock locations (godowns).",
      "A godown is a physical place stock lives — main shop, warehouse, branch.",
      "One godown is marked primary; document lines that omit a location are attributed to it.",
    ].join(" "),
    {},
    wrapTool(async () => json(await client.inventory.godowns()))
  );

  server.tool(
    "inventory_stock_by_godown",
    [
      "Get the stock of one item broken down by godown.",
      "Returns the business-wide total, the per-godown breakdown, and an `unattributed` figure.",
      "`unattributed` is stock the lots do not account for — non-zero after a business switches an",
      "already-stocked item to batch/serial/expiry tracking. Report it rather than hiding it.",
    ].join(" "),
    {
      item_id: z.string().uuid().describe("The items.id UUID."),
      variant_id: z.string().uuid().optional().describe("Set for items that use variants."),
    },
    wrapTool(async (input) => json(await client.inventory.stockByGodown(input.item_id, input.variant_id)))
  );

  server.tool(
    "inventory_transfer_stock",
    [
      "Move stock between two godowns.",
      "The business-wide total is unchanged — this only re-attributes where the stock sits.",
      "The item must use lot tracking (batch/serial/expiry), otherwise there is no per-godown ledger to move.",
    ].join(" "),
    {
      item_id: z.string().uuid().describe("The items.id UUID."),
      quantity: z.string().describe("Quantity to move, e.g. '20' or '12.500'."),
      from_godown_id: z.string().uuid().optional().describe("Source godown. Omit when the destination had no prior stock."),
      to_godown_id: z.string().uuid().describe("Destination godown UUID."),
      reference_number: z.string().optional().describe("Document reference for the transfer."),
      notes: z.string().optional().describe("Free-text note."),
    },
    wrapTool(async (input) =>
      json(await client.inventory.transfer({
        itemId: input.item_id,
        quantity: input.quantity,
        fromGodownId: input.from_godown_id,
        toGodownId: input.to_godown_id,
        referenceNumber: input.reference_number,
        notes: input.notes,
      }))
    )
  );

  server.tool(
    "inventory_allocate_fefo",
    [
      "Work out which lots a sale should draw from, earliest expiry first (FEFO).",
      "Returns an ordered allocation plan WITHOUT changing stock — safe to call for planning or to show a user.",
      "Each plan entry gives `available` and `allocate`. `shortfall` is what the lots could not cover,",
      "so the caller decides whether to backorder or block. Quarantined and depleted lots are never suggested.",
    ].join(" "),
    {
      item_id: z.string().uuid().describe("The items.id UUID."),
      quantity: z.string().describe("Quantity about to be sold, e.g. '5'."),
      godown_id: z.string().uuid().optional().describe("Restrict allocation to one godown."),
    },
    wrapTool(async (input) =>
      json(await client.inventory.allocateFEFO({
        itemId: input.item_id,
        quantity: input.quantity,
        godownId: input.godown_id,
      }))
    )
  );

  server.tool(
    "inventory_lots",
    [
      "List stock lots (batches / serial units) with quantities and expiry dates.",
      "Ordered by earliest expiry first, so the lot that should sell next is at the top.",
    ].join(" "),
    {
      item_id: z.string().uuid().optional().describe("Restrict to one item."),
      godown_id: z.string().uuid().optional().describe("Restrict to one godown."),
      batch_no: z.string().optional().describe("Restrict to one batch number."),
      in_stock_only: z.boolean().optional().describe("Only lots with stock on hand. Defaults to true."),
    },
    wrapTool(async (input) =>
      json(await client.inventory.lots({
        itemId: input.item_id,
        godownId: input.godown_id,
        batchNo: input.batch_no,
        inStockOnly: input.in_stock_only,
      }))
    )
  );

  server.tool(
    "inventory_expiring_soon",
    [
      "List lots expiring within a window, for expiry-risk review.",
      "Each row carries `daysRemaining` and `alreadyExpired`. Use this before writing off stock,",
      "or to plan a sale of near-expiry batches first.",
    ].join(" "),
    {
      within_days: z.number().int().min(1).max(365).optional()
        .describe("Look ahead this many days. Defaults to 30."),
    },
    wrapTool(async (input) => json(await client.inventory.expiringSoon(input.within_days)))
  );
}

