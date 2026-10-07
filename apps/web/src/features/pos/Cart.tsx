import { POSStore, usePOSSelector, computeCartTotals } from "./state";
import { calcLineItem, money } from "@hisaabo/shared";
import { cn } from "@/lib/utils";

interface Props {
  store: POSStore;
  /**
   * The selected customer's outstanding dues (positive = they owe you), or
   * undefined for a walk-in sale / while the balance is still loading. When a
   * number is supplied the dues banner is rendered above the cart.
   */
  outstanding?: number;
}

function fmt(n: number): string {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

/**
 * Customer dues banner — shown above the cart once a named customer is
 * selected. Surfaces their outstanding balance (what they still owe from
 * previous bills) so the cashier can ask for it at the counter, and warns
 * loudly when there is money due.
 */
function DuesBanner({ name, outstanding }: { name: string; outstanding: number }) {
  const owes = outstanding > 0.005;
  const credit = outstanding < -0.005;
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 border-b px-4 py-2.5",
        owes
          ? "border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/30"
          : credit
            ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/30"
            : "border-border-light bg-surface-2",
      )}
      role="status"
    >
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 truncate text-xs font-semibold text-text-primary">
          {owes && (
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
          )}
          {name}
        </p>
        <p
          className={cn(
            "mt-0.5 text-[11px]",
            owes ? "text-red-600 dark:text-red-400" : "text-text-tertiary",
          )}
        >
          {owes
            ? "Previous balance due"
            : credit
              ? "Advance / credit balance"
              : "No outstanding dues"}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p
          className={cn(
            "text-sm font-bold tabular-nums",
            owes
              ? "text-red-600 dark:text-red-400"
              : credit
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-text-secondary",
          )}
        >
          ₹{fmt(Math.abs(outstanding))}
        </p>
      </div>
    </div>
  );
}

/**
 * Right-pane cart for POS.
 *
 * Sized for touch: WCAG recommends ≥44px tap targets; Material Design
 * prefers 48px. These controls go to 44px minimum (the + / − buttons are
 * 48px to stand out as the primary interaction), which lets a cashier tap
 * them reliably with a finger or barcode scanner in hand without fat-
 * fingering the next line.
 */
export function Cart({ store, outstanding }: Props) {
  const activeCart = usePOSSelector(store, (s) => s.carts.find((c) => c.id === s.activeCartId));
  if (!activeCart) return null;

  const totals = computeCartTotals(activeCart.lineItems);

  return (
    <div className="flex flex-col h-full bg-surface-1 border-l border-border">
      {outstanding !== undefined && (
        <DuesBanner name={activeCart.partyName} outstanding={outstanding} />
      )}
      <div className="flex-1 overflow-y-auto">
        {activeCart.lineItems.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-2 text-text-tertiary">
              <CartIcon />
            </div>
            <p className="text-sm font-medium text-text-secondary">Your cart is empty</p>
            <p className="max-w-[220px] text-xs text-text-tertiary">
              Scan a barcode or tap an item to add it here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {activeCart.lineItems.map((li) => {
              const qty = parseFloat(li.quantity) || 0;
              // Use the same shared calc the server and the totals bar use, so
              // a row can never disagree with the bottom total. The old inline
              // `qty * price * (1 - disc/100)` omitted tax entirely, meaning
              // the visible rows never summed to the visible total.
              const lineCalc = calcLineItem({
                quantity: li.quantity || "0",
                unitPrice: li.unitPrice || "0",
                taxPercent: li.taxPercent || "0",
                discountPercent: li.discountPercent || "0",
              });
              const lineTotal = money.toNumber(lineCalc.total);
              return (
                <li key={li.lineId} className="animate-cart-add px-3 py-4">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] font-semibold text-text-primary leading-tight">
                        {li.itemName}
                      </div>
                      <div className="text-xs text-text-tertiary mt-1 flex items-center gap-1 flex-wrap tabular-nums">
                        {/* Editable price — cashier price override, same
                            capability the invoice builder gives per line. */}
                        <span className="text-text-secondary">₹</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          min="0"
                          value={li.unitPrice}
                          onChange={(e) =>
                            store.updateLine(li.lineId, {
                              unitPrice: e.target.value,
                            })
                          }
                          aria-label={`Price for ${li.itemName}`}
                          className="w-20 px-1.5 py-0.5 rounded border border-border bg-surface-2 text-text-primary text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-brand-600"
                        />
                        <span>× {li.quantity} {li.unit}</span>
                        {/* Line discount. discountPercent already flowed to the
                            server all along — there was simply no way to set
                            it. */}
                        <label className="inline-flex items-center gap-0.5">
                          <span className="text-text-tertiary">disc</span>
                          <input
                            type="number"
                            inputMode="decimal"
                            step="0.01"
                            min="0"
                            max="100"
                            value={li.discountPercent}
                            onChange={(e) => {
                              const v = e.target.value;
                              store.updateLine(li.lineId, {
                                discountPercent: v === "" ? "0" : v,
                              });
                            }}
                            aria-label={`Discount percent for ${li.itemName}`}
                            className="w-14 px-1.5 py-0.5 rounded border border-border bg-surface-2 text-text-primary text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-brand-600"
                          />
                          <span className="text-text-tertiary">%</span>
                        </label>
                      </div>
                    </div>
                    <div className="text-right min-w-[88px]">
                      <div className="text-base font-bold tabular-nums">
                        ₹{fmt(lineTotal)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="w-12 h-12 rounded-lg bg-surface-2 hover:bg-surface-3 active:bg-surface-3 text-2xl font-semibold flex items-center justify-center disabled:opacity-40"
                        onClick={() =>
                          store.updateLine(li.lineId, {
                            quantity: Math.max(1, qty - 1).toString(),
                          })
                        }
                        disabled={qty <= 1}
                        aria-label="Decrease quantity"
                      >
                        −
                      </button>
                      <span className="min-w-[3ch] text-center text-lg font-semibold tabular-nums">
                        {qty}
                      </span>
                      <button
                        type="button"
                        className="w-12 h-12 rounded-lg bg-surface-2 hover:bg-surface-3 active:bg-surface-3 text-2xl font-semibold flex items-center justify-center"
                        onClick={() =>
                          store.updateLine(li.lineId, {
                            quantity: (qty + 1).toString(),
                          })
                        }
                        aria-label="Increase quantity"
                      >
                        +
                      </button>
                    </div>

                    <button
                      type="button"
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-red-500/10 hover:text-red-500 active:bg-red-500/20"
                      onClick={() => store.removeLine(li.lineId)}
                      aria-label={`Remove ${li.itemName} from cart`}
                      title="Remove"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-border bg-surface-0 px-4 py-3 text-sm">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-text-secondary">
            <span>Subtotal</span>
            <span className="tabular-nums">₹{fmt(totals.subtotal)}</span>
          </div>
          {totals.discount > 0 && (
            <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
              <span>Discount</span>
              <span className="tabular-nums">−₹{fmt(totals.discount)}</span>
            </div>
          )}
          <div className="flex items-center justify-between text-text-secondary">
            <span>Tax</span>
            <span className="tabular-nums">₹{fmt(totals.tax)}</span>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between rounded-xl bg-brand-600/10 px-3 py-2.5">
          <span className="text-sm font-semibold text-brand-700 dark:text-brand-300">Total</span>
          <span className="text-2xl font-bold tabular-nums text-brand-700 dark:text-brand-300">
            ₹{fmt(totals.total)}
          </span>
        </div>
      </div>
    </div>
  );
}

function TrashIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a2 2 0 012-2h2a2 2 0 012 2v2" />
    </svg>
  );
}

function CartIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-7 w-7"
      aria-hidden="true"
    >
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="18" cy="20" r="1.5" />
      <path d="M2 3h2.5l2.2 12.2a2 2 0 002 1.6h8.6a2 2 0 002-1.6L21 7H6" />
    </svg>
  );
}
