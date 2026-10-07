import { useEffect, useRef, useState } from "react";
import { trpc, getBusinessId } from "@/lib/trpc";
import { apiUrl } from "@/lib/api-url";
import { cn } from "@/lib/utils";

/**
 * One row from the `pos.catalog` tRPC endpoint. Already fanned out to a
 * single billable tile (simple item, alt_units entry, or variant row).
 */
export interface POSTile {
  tileKey: string;
  itemId: string;
  variantId: string | null;
  displayName: string;
  unit: string;
  unitPrice: string;
  stockQuantity: string;
  taxPercent: string;
  conversionFactor: string;
  itemMode: "simple" | "alt_units" | "variants";
  sku: string | null;
  /** True when the item has an uploaded image. */
  hasImage: boolean;
  /** Cache-bust token for the image URL; null when there is no image. */
  imageUpdatedAt: string | null;
}

interface Props {
  search: string;
  onPick: (tile: POSTile) => void;
}

/**
 * Left-pane tile grid for POS. One tile per billable SKU — an item with
 * alt_units or variants appears as multiple tiles so cashiers tap the
 * exact unit/variant they're ringing up.
 *
 * Visual design: price is the hero (the number the cashier reads at a
 * glance), the item name sits above it, and a colour-coded stock pill sits
 * beside the price (green = healthy, amber = low, red = out). Tapping a tile
 * plays a short press animation plus a green ✓ flash so the cashier gets
 * confirmation without looking away at the cart.
 */
export function ItemGrid({ search, onPick }: Props) {
  const { data, isPending, isError } = trpc.pos.catalog.useQuery(
    {
      search: search || null,
      page: 1,
      limit: 120, // variants/alt_units fan out — keep a higher ceiling
    },
    {
      // Keep previous results on screen while a new search request runs so
      // the grid doesn't flash to empty between keystrokes.
      placeholderData: (prev) => prev,
    },
  );

  const [tappedKey, setTappedKey] = useState<string | null>(null);
  const [tapNonce, setTapNonce] = useState(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(tapTimer.current), []);

  function handleTap(tile: POSTile) {
    onPick(tile);
    setTappedKey(tile.tileKey);
    setTapNonce((n) => n + 1);
    clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => setTappedKey(null), 480);
  }

  if (isError) {
    return <div className="p-6 text-sm text-red-500">Couldn't load items.</div>;
  }

  const tiles = data?.tiles ?? [];

  // First load with nothing cached — show a skeleton grid instead of a blank
  // pane so the register doesn't look broken while the catalog loads.
  if (isPending && tiles.length === 0) {
    return (
      <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5 p-3 content-start">
        {Array.from({ length: 18 }).map((_, i) => (
          <div key={i} className="skeleton h-[120px] rounded-xl" />
        ))}
      </div>
    );
  }

  if (tiles.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-text-tertiary">
          <SearchIcon />
        </div>
        <p className="text-sm font-medium text-text-secondary">
          {search ? `No items match "${search}"` : "No items to sell yet"}
        </p>
        <p className="max-w-xs text-xs text-text-tertiary">
          {search
            ? "Try a different name or SKU, or scan the barcode."
            : "Add products in Items to see them on the register."}
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5 p-3 content-start overflow-y-auto">
      {tiles.map((tile) => {
        const tapped = tappedKey === tile.tileKey;
        const stock = parseFloat(tile.stockQuantity);
        const out = !Number.isFinite(stock) || stock <= 0;
        return (
          <button
            key={tile.tileKey}
            type="button"
            onClick={() => handleTap(tile)}
            className={cn(
              "group relative flex min-h-[120px] flex-col rounded-xl border bg-surface-1 p-3 text-left",
              "transition-all duration-150 hover:-translate-y-0.5 hover:bg-surface-2 hover:shadow-elevated",
              "focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-offset-1",
              out
                ? "border-red-200 dark:border-red-900/50"
                : "border-border hover:border-brand-300 dark:hover:border-brand-800",
              tapped && "animate-pos-tap border-brand-400 dark:border-brand-600",
            )}
          >
            {/* Image + name + mode badge */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
                {tile.hasImage && (
                  <img
                    src={itemImageSrc(tile)}
                    alt=""
                    loading="lazy"
                    className="h-9 w-9 shrink-0 rounded-md border border-border-light bg-surface-2 object-cover"
                  />
                )}
                <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-text-primary">
                  {tile.displayName}
                </span>
              </div>
              {tile.itemMode !== "simple" && (
                <span className="shrink-0 rounded bg-brand-600/10 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-700 dark:text-brand-400">
                  {tile.itemMode === "variants" ? "Var" : "Unit"}
                </span>
              )}
            </div>

            {/* Price (hero) + stock pill */}
            <div className="mt-auto flex items-end justify-between gap-2 pt-3">
              <div className="min-w-0">
                <div className="text-lg font-bold leading-none tabular-nums text-text-primary">
                  ₹{formatPrice(tile.unitPrice)}
                </div>
                <div className="mt-0.5 text-[11px] text-text-tertiary">per {tile.unit}</div>
              </div>
              <StockPill quantity={tile.stockQuantity} unit={tile.unit} />
            </div>

            {/* Tap confirmation overlay */}
            {tapped && (
              <span
                key={tapNonce}
                className="pointer-events-none absolute inset-0 flex animate-check-pop items-center justify-center rounded-xl bg-emerald-500/15"
                aria-hidden="true"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500 text-white shadow-elevated">
                  <CheckIcon />
                </span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Stock pill ───────────────────────────────────────────────────

function StockPill({ quantity, unit }: { quantity: string; unit: string }) {
  const n = parseFloat(quantity);
  const out = !Number.isFinite(n) || n <= 0;
  const low = !out && n <= 10;
  const cls = out
    ? "bg-red-500/10 text-red-600 dark:text-red-400"
    : low
      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
      : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  return (
    <span
      className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums", cls)}
      title={out ? "Out of stock" : low ? "Low stock" : "In stock"}
    >
      {formatStock(quantity)} {unit}
    </span>
  );
}

// ── Image URL ────────────────────────────────────────────────────

/**
 * Build the URL for an item's image. The business id goes in the query string
 * because <img> can't send the x-business-id header; the v= token busts the
 * cache whenever the image is replaced.
 */
function itemImageSrc(tile: POSTile): string {
  const biz = encodeURIComponent(getBusinessId() ?? "");
  const v = encodeURIComponent(tile.imageUpdatedAt ?? "0");
  return `${apiUrl(`/api/items/${tile.itemId}/image`)}?b=${biz}&v=${v}`;
}

// ── Formatting ───────────────────────────────────────────────────

function formatPrice(raw: string): string {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return raw;
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function formatStock(raw: string): string {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return "0";
  // Drop trailing zeros on decimals so "5000.000" shows as "5000" but
  // "5.250" stays "5.25". Avoids a wall of zeros on whole-number stocks.
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, "");
}

// ── Icons ────────────────────────────────────────────────────────

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-6 w-6"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
