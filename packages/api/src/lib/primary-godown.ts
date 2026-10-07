/**
 * primary-godown.ts — resolve the godown a document line defaults to.
 *
 * A document line that omits `godownId` is attributed to the business's PRIMARY
 * godown. This is the single source of truth for that fallback, used by both the
 * document engine (lot ledger) and the inventory router.
 */

import { and, eq, isNull } from "drizzle-orm";
import { godowns } from "@hisaabo/db";

/** The primary godown id for a business, or null when it has none. */
export async function getPrimaryGodownId(
  tx: any,
  businessId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: godowns.id })
    .from(godowns)
    .where(and(eq(godowns.businessId, businessId), eq(godowns.isPrimary, true), isNull(godowns.deletedAt)))
    .limit(1);
  return row?.id ?? null;
}
