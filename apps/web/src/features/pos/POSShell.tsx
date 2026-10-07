import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { trpc } from "@/lib/trpc";
import { toast } from "@/hooks/useToast";
import { POSStore, usePOSSelector, computeCartTotals } from "./state";
import { useScanner } from "./useScanner";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { ItemGrid, type POSTile } from "./ItemGrid";
import { Cart } from "./Cart";
import { CustomerPicker } from "./CustomerPicker";
import { PaymentSheet } from "./PaymentSheet";
import { ReceiptPrinter } from "./ReceiptPrinter";

interface Props {
  businessId: string;
  walkInPartyId: string;
}

/**
 * POS fullscreen shell — layout + keyboard + scanner + cross-tab stock
 * broadcast. Owns a single `POSStore` instance for this tab's lifetime.
 */
export function POSShell({ businessId, walkInPartyId }: Props) {
  const navigate = useNavigate();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [printInvoiceId, setPrintInvoiceId] = useState<string | null>(null);

  // ── Dispatch godown ────────────────────────────────────────────
  //
  // ONE selector for the whole register rather than one per cart line. At a
  // till the question is "which shelf am I standing at?", and it stays the same
  // for every item in the sale — making the user set it 20 times for a 20-item
  // bill would guarantee they leave it blank.
  //
  // Left blank, the server allocates FEFO across every godown, which is the
  // correct default for a single-godown shop and a safe fallback for any other.
  const [dispatchGodownId, setDispatchGodownId] = useState("");
  const { data: godowns } = trpc.inventory.list.useQuery();

  // Store is tied to businessId — recreate if the active business changes.
  const store = useMemo(
    () => new POSStore(businessId, walkInPartyId),
    [businessId, walkInPartyId],
  );

  const carts = usePOSSelector(store, (s) => s.carts);
  const activeCartId = usePOSSelector(store, (s) => s.activeCartId);
  const activeCart = carts.find((c) => c.id === activeCartId);
  const totals = activeCart ? computeCartTotals(activeCart.lineItems) : null;

  // Outstanding dues for the selected customer. Walk-in sales have no ledger,
  // so the balance bar is only shown for a real, named customer.
  const isWalkIn = !activeCart || activeCart.partyId === walkInPartyId;
  const { data: activeParty } = trpc.party.getById.useQuery(
    { id: activeCart?.partyId ?? "" },
    { enabled: !!activeCart?.partyId },
  );
  const outstanding = activeParty ? parseFloat(activeParty.balance) || 0 : undefined;

  const utils = trpc.useUtils();

  // ── Cross-tab coordination ─────────────────────────────────────
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(`pos:${businessId}`);
    channel.onmessage = (ev) => {
      if (!ev.data) return;
      // Another tab finalised a sale — invalidate stock/listings.
      if (ev.data.type === "invoice:finalized") {
        utils.item.list.invalidate();
      }
    };
    return () => channel.close();
  }, [businessId, utils]);

  const broadcast = (payload: unknown) => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(`pos:${businessId}`);
    try {
      channel.postMessage(payload);
    } finally {
      channel.close();
    }
  };

  // ── Scanner ────────────────────────────────────────────────────
  const handleScan = async (code: string) => {
    // Resolve barcode → first matching catalog tile. pos.catalog already
    // handles variant/alt-unit expansion and filters by SKU, so a scanned
    // SKU lands on exactly one tile (or the first of several).
    try {
      const data = await utils.pos.catalog.fetch({ search: code, page: 1, limit: 1 });
      const first = data?.tiles?.[0];
      if (!first) {
        toast.error("No item found", `Scan: ${code}`);
        return;
      }
      handlePickItem(first);
    } catch (err) {
      toast.error("Scanner lookup failed", err instanceof Error ? err.message : String(err));
    }
  };
  useScanner(shellRef, handleScan);

  // ── Keyboard shortcuts ─────────────────────────────────────────
  const shortcuts = useMemo(
    () => [
      { combo: "F2", handler: () => searchRef.current?.focus() },
      { combo: "F3", handler: () => setPickerOpen(true) },
      { combo: "F9", handler: () => setPaymentOpen(true) },
      { combo: "F6", handler: () => store.parkActive(walkInPartyId, "Walk-in Customer") },
      { combo: "Escape", handler: () => {
        setPickerOpen(false);
        setPaymentOpen(false);
      }},
      ...[1, 2, 3, 4, 5].map((n) => ({
        combo: `Alt+${n}`,
        handler: () => {
          const target = carts[n - 1];
          if (target) store.resumeCart(target.id);
        },
      })),
    ],
    [carts, store, walkInPartyId],
  );
  useKeyboardShortcuts(shellRef, shortcuts);

  // ── Tile → cart handler ────────────────────────────────────────
  // Matches the tile's composite identity (item + variant OR item + unit)
  // so two different alt-units of the same item don't merge into one line.
  const handlePickItem = (tile: POSTile) => {
    store.addOrBumpLine(
      { itemId: tile.itemId, variantId: tile.variantId, unit: tile.unit },
      {
        itemId: tile.itemId,
        variantId: tile.variantId,
        itemName: tile.displayName,
        quantity: "1",
        unit: tile.unit,
        unitPrice: tile.unitPrice,
        taxPercent: tile.taxPercent,
        discountPercent: "0",
        conversionFactor: tile.conversionFactor,
      },
    );
  };

  const handleCustomerPick = (p: { id: string; name: string }) => {
    store.setCustomer(p.id, p.name);
    setPickerOpen(false);
  };

  const handleFinalized = (invoiceId: string) => {
    setPaymentOpen(false);
    // Print receipt (fire-and-forget)
    setPrintInvoiceId(invoiceId);
    // Drop the finalised cart and start a fresh one
    if (activeCart) {
      store.removeCart(activeCart.id, walkInPartyId, "Walk-in Customer");
    }
    // Tell other tabs to invalidate stock
    broadcast({ type: "invoice:finalized", invoiceId });
    // The sale changed this customer's dues — refresh party balances.
    utils.party.getById.invalidate();
    utils.party.list.invalidate();
    toast.success("Sale complete", `Invoice ${invoiceId.slice(0, 8)}`);
  };

  return (
    <div
      ref={shellRef}
      tabIndex={-1}
      className="fixed inset-0 flex flex-col bg-surface-0 text-text-primary outline-none"
    >
      {/* Top bar */}
      <header className="flex items-center gap-2.5 px-4 py-2.5 border-b border-border bg-surface-1">
        <button
          type="button"
          onClick={() => navigate({ to: "/invoices" })}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-0 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          aria-label="Exit POS"
          title="Exit POS"
        >
          <BackIcon />
        </button>

        {/* Search — the primary control */}
        <div className="relative min-w-0 flex-1 max-w-2xl">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary">
            <SearchIcon />
          </span>
          <input
            ref={searchRef}
            type="search"
            className="h-10 w-full rounded-lg border border-border bg-surface-0 pl-9 pr-14 text-sm outline-none transition-colors focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20"
            placeholder="Search items or scan a barcode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden h-5 -translate-y-1/2 items-center rounded border border-border bg-surface-2 px-1.5 text-[10px] font-medium text-text-tertiary sm:inline-flex">
            F2
          </kbd>
        </div>

        {/* Customer pill */}
        <button
          type="button"
          className="flex h-10 shrink-0 items-center gap-2 rounded-lg border border-border bg-surface-0 px-3 text-sm transition-colors hover:bg-surface-2"
          onClick={() => setPickerOpen(true)}
          title="Change customer (F3)"
        >
          <UserIcon />
          <span className="max-w-[130px] truncate font-medium">
            {activeCart?.partyName ?? "Walk-in"}
          </span>
          {!isWalkIn && outstanding !== undefined && outstanding > 0.005 && (
            <span
              className="shrink-0 rounded-md bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-red-600 dark:text-red-400"
              title="Outstanding balance due"
            >
              ₹{fmtMoney(outstanding)}
            </span>
          )}
          <kbd className="hidden h-5 items-center rounded border border-border bg-surface-2 px-1.5 text-[10px] font-medium text-text-tertiary md:inline-flex">
            F3
          </kbd>
        </button>

        {/* Hold */}
        <button
          type="button"
          className="flex h-10 shrink-0 items-center gap-2 rounded-lg border border-border bg-surface-0 px-3 text-sm transition-colors hover:bg-surface-2"
          onClick={() => store.parkActive(walkInPartyId, "Walk-in Customer")}
          title="Hold current sale and start a new one (F6)"
        >
          <PauseIcon />
          <span className="hidden font-medium md:inline">Hold</span>
        </button>

        {/* Dispatch godown — only shown once the business has godowns to
            choose from. A single-location shop never sees it. */}
        {godowns && godowns.length > 0 && (
          <label className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface-0 px-3 text-xs text-text-tertiary">
            <PackageIcon />
            <select
              value={dispatchGodownId}
              onChange={(e) => setDispatchGodownId(e.target.value)}
              aria-label="Dispatch godown"
              className="max-w-[140px] bg-transparent text-sm text-text-primary outline-none"
            >
              <option value="">Any godown</option>
              {godowns.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {/* Parked tabs strip — always rendered so the layout doesn't shift
          when a cashier parks their first sale. The active cart is shown
          as a selected tab; a "+ Hold" affordance sits alongside so the
          park concept is discoverable without having used it first. */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-surface-1 overflow-x-auto min-h-[48px]">
        {carts.map((c, idx) => (
          <button
            key={c.id}
            type="button"
            onClick={() => store.resumeCart(c.id)}
            className={`h-9 px-3 rounded-md text-xs whitespace-nowrap transition-colors flex items-center gap-2 ${
              c.id === activeCartId
                ? "bg-brand-600 text-white"
                : "bg-surface-2 hover:bg-surface-3 text-text-secondary"
            }`}
          >
            <span className={c.id === activeCartId ? "opacity-80" : "opacity-60"}>
              Alt+{idx + 1}
            </span>
            <span className="font-medium">{c.partyName}</span>
            <span className="opacity-70">· {c.lineItems.length}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => store.parkActive(walkInPartyId, "Walk-in Customer")}
          className="h-9 px-3 rounded-md text-xs whitespace-nowrap border border-dashed border-border text-text-tertiary hover:text-text-secondary hover:border-text-tertiary flex items-center gap-1"
          title="Hold current sale and start a new one (F6)"
          disabled={carts.length >= 5}
        >
          + Hold <span className="opacity-60">F6</span>
        </button>
      </div>

      {/* Main two-pane */}
      <main className="flex-1 flex min-h-0">
        <section className="flex-1 min-w-0 overflow-hidden">
          <ItemGrid search={search} onPick={handlePickItem} />
        </section>
        <aside className="w-[360px] flex-shrink-0 flex flex-col min-h-0">
          <Cart store={store} outstanding={isWalkIn ? undefined : outstanding} />
        </aside>
      </main>

      {/* Bottom pay bar */}
      <footer className="flex items-center gap-3 border-t border-border bg-surface-1 px-4 py-3">
        <div className="hidden items-center gap-3 text-[11px] text-text-tertiary lg:flex">
          <HintKey k="F2" label="Search" />
          <HintKey k="F3" label="Customer" />
          <HintKey k="F6" label="Hold" />
          <HintKey k="Alt+1-5" label="Switch" />
        </div>
        <div className="flex-1" />
        {activeCart && activeCart.lineItems.length > 0 && (
          <span className="text-xs tabular-nums text-text-tertiary">
            {activeCart.lineItems.length} item{activeCart.lineItems.length !== 1 ? "s" : ""}
          </span>
        )}
        <button
          type="button"
          className="btn-primary px-8 py-3 text-base"
          onClick={() => setPaymentOpen(true)}
          disabled={!activeCart || activeCart.lineItems.length === 0}
        >
          {activeCart && activeCart.lineItems.length > 0
            ? `Pay ₹${fmtMoney(totals?.total ?? 0)} · F9`
            : "Pay · F9"}
        </button>
      </footer>

      <CustomerPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handleCustomerPick}
        walkIn={{ id: walkInPartyId, name: "Walk-in Customer" }}
      />
      {activeCart && (
        <PaymentSheet
          open={paymentOpen}
          cart={activeCart}
          onClose={() => setPaymentOpen(false)}
          onFinalized={handleFinalized}
          dispatchGodownId={dispatchGodownId}
        />
      )}
      <ReceiptPrinter
        invoiceId={printInvoiceId}
        onDone={() => setPrintInvoiceId(null)}
      />
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function HintKey({ k, label }: { k: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <kbd className="inline-flex h-5 items-center rounded border border-border bg-surface-2 px-1.5 text-[10px] font-medium text-text-tertiary">
        {k}
      </kbd>
      {label}
    </span>
  );
}

// ── Icons ────────────────────────────────────────────────────────

function iconProps(className = "h-4 w-4") {
  return {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
}

function BackIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg {...iconProps()}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg {...iconProps("h-4 w-4 text-text-tertiary")}>
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function PackageIcon() {
  return (
    <svg {...iconProps("h-4 w-4")}>
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
      <path d="M3.3 7l8.7 5 8.7-5M12 22V12" />
    </svg>
  );
}
