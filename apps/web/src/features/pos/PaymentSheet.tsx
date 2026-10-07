import { useEffect, useState, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/hooks/useToast";
import { toISOString, todayISODate } from "@/lib/utils";
import type { POSCart } from "./state";
import { computeCartTotals } from "./state";

interface Props {
  open: boolean;
  cart: POSCart;
  onClose: () => void;
  onFinalized: (invoiceId: string) => void;
  /**
   * Godown the whole sale is dispatched from, chosen once at the register.
   *
   * Blank means "any godown", and the server then allocates FEFO across every
   * location — correct for a single-godown shop, and a safe fallback for a
   * multi-location one where the cashier did not set it.
   */
  dispatchGodownId?: string;
}

type Mode = "cash" | "upi" | "pending";

/**
 * Bottom payment sheet. Three mode tiles (Cash / UPI / Pending), shows the
 * total, confirms, creates an invoice + payment, and hands back the invoice id
 * for receipt printing.
 *
 * Pending mode ("keep unpaid" / "partial"): the invoice is created exactly as
 * before but NO payment row is written, leaving it as a normal unpaid "sent"
 * invoice with an outstanding balance. This is what a counter needs for
 * "customer will pay later" or "paid part now, rest on delivery" — previously
 * there was no way to ring up a sale without settling it in full.
 *
 * Failure mode: if invoice creates but payment fails, we surface the error
 * and DON'T clear the cart. The user can retry payment via the normal flow.
 * The invoice lives as an unpaid "sent" sale.
 */
export function PaymentSheet({ open, cart, onClose, onFinalized, dispatchGodownId }: Props) {
  const [mode, setMode] = useState<Mode>("cash");
  const [phase, setPhase] = useState<"idle" | "creating" | "paying">("idle");
  // Amount actually collected now, for partial payment. Defaults to the full
  // total; the cashier lowers it when the customer pays part now.
  const [received, setReceived] = useState("");

  useEffect(() => {
    if (!open) {
      setPhase("idle");
      setReceived("");
    }
  }, [open]);

  const createInvoice = trpc.invoice.create.useMutation();
  const createPayment = trpc.payment.create.useMutation();

  const totals = computeCartTotals(cart.lineItems);

  // Live change-due: what the cashier still owes back when the tendered
  // amount exceeds the bill. Blank means "exact", so change is 0.
  const receivedNum = received.trim() === "" ? totals.total : parseFloat(received);
  const change = Number.isFinite(receivedNum) ? Math.max(receivedNum - totals.total, 0) : 0;

  async function handleConfirm() {
    if (cart.lineItems.length === 0) {
      toast.error("Cart is empty");
      return;
    }
    setPhase("creating");
    let invoiceId: string | undefined;
    let invoiceTotal: string | undefined;
    try {
      const inv = await createInvoice.mutateAsync({
        partyId: cart.partyId,
        type: "sale",
        documentType: "invoice",
        // Tag this invoice as originating from the POS register so reports
        // and the invoice list can attribute revenue by channel.
        source: "pos",
        // Every POS sale is "just another invoice" — the server is the
        // single source of truth for numbering, stock, GST, and audit.
        // selectedUnit + conversionFactor + variantId are what let the
        // existing stock-decrement path work correctly for alt_units and
        // variants without any POS-specific server logic.
        lineItems: cart.lineItems.map((li) => ({
          itemId: li.itemId ?? undefined,
          variantId: li.variantId ?? undefined,
          itemName: li.itemName,
          quantity: li.quantity,
          selectedUnit: li.unit,
          conversionFactor: li.conversionFactor,
          unitPrice: li.unitPrice,
          taxPercent: li.taxPercent,
          discountPercent: li.discountPercent,
          // Applied to every line: a till dispatches from one place. Blank
          // stays undefined so the server's FEFO fallback runs.
          godownId: dispatchGodownId || undefined,
        })),
        additionalCharges: "0",
        invoiceDiscount: "0",
        invoiceDiscountType: "amount",
        roundOff: "0",
        isReverseCharge: false,
        deliveryMethod: "self_pickup",
      });
      invoiceId = inv.id;
      invoiceTotal = inv.totalAmount;
    } catch (err) {
      setPhase("idle");
      toast.error("Could not create sale", err instanceof Error ? err.message : String(err));
      return;
    }

    setPhase("paying");
    // "Pending" means: create the invoice, write NO payment row. The invoice
    // lands as a normal unpaid "sent" document with the full amount
    // outstanding, which the customer can settle later from the normal
    // payments screen.
    if (mode === "pending") {
      setPhase("idle");
      onFinalized(invoiceId);
      return;
    }

    // Partial payment: default to the full total when the cashier hasn't
    // entered anything, otherwise honour what they collected. Clamped to the
    // total so a typo can't record an overpayment the invoice then rejects.
    const parsedReceived = received.trim() === "" ? NaN : parseFloat(received);
    const totalNum = parseFloat(invoiceTotal!);
    const amountToRecord = Number.isFinite(parsedReceived)
      ? Math.min(Math.max(parsedReceived, 0), totalNum)
      : totalNum;

    if (amountToRecord > 0) {
      try {
        await createPayment.mutateAsync({
          invoiceId,
          partyId: cart.partyId,
          amount: amountToRecord.toFixed(2),
          mode,
          // Calendar date = today (UTC midnight), consistent with every other
          // payment form — `new Date()` would stamp an instant that falls
          // outside the dashboard's UTC "Today" window before ~05:30 IST.
          paymentDate: toISOString(todayISODate()),
        });
      } catch (err) {
        setPhase("idle");
        toast.error(
          "Sale saved but payment step failed",
          `Invoice created. Settle payment via the normal flow. ${err instanceof Error ? err.message : ""}`,
        );
        // Still advance — the invoice exists and the cashier can reprint later.
        onFinalized(invoiceId);
        return;
      }
    }

    setPhase("idle");
    onFinalized(invoiceId);
  }

  if (!open) return null;

  const busy = phase !== "idle";

  return (
    <div
      className="fixed inset-0 z-40 bg-black/40 flex items-end justify-center"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="w-full max-w-lg bg-surface-1 border border-border rounded-t-2xl shadow-xl p-6 space-y-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold">Take Payment</h2>
          <div className="text-3xl font-bold tabular-nums">
            ₹{totals.total.toFixed(2)}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <PayModeTile
            active={mode === "cash"}
            onClick={() => setMode("cash")}
            label="Cash"
            hint="F9"
            icon={<CashIcon />}
          />
          <PayModeTile
            active={mode === "upi"}
            onClick={() => setMode("upi")}
            label="UPI"
            hint="F10"
            icon={<UpiIcon />}
          />
          <PayModeTile
            active={mode === "pending"}
            onClick={() => setMode("pending")}
            label="Pending"
            hint="Pay later"
            icon={<ClockIcon />}
          />
        </div>

        {mode === "pending" ? (
          <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-text-secondary">
            Sale is saved <strong className="text-text-primary">unpaid</strong>. Collect the
            balance later from the Payments screen.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <label className="whitespace-nowrap text-sm text-text-secondary" htmlFor="pos-received">
                {mode === "cash" ? "Cash received" : "Amount received"}
              </label>
              <input
                id="pos-received"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                placeholder={totals.total.toFixed(2)}
                value={received}
                onChange={(e) => setReceived(e.target.value)}
                className="input flex-1 tabular-nums"
              />
            </div>

            {mode === "cash" && (
              <div className="flex flex-wrap gap-2">
                <QuickAmount label="Exact" onClick={() => setReceived(totals.total.toFixed(2))} />
                {[100, 500, 1000, 2000].map((amt) => (
                  <QuickAmount key={amt} label={`₹${amt}`} onClick={() => setReceived(String(amt))} />
                ))}
              </div>
            )}

            {change > 0 && (
              <div className="flex items-center justify-between rounded-lg bg-emerald-500/10 px-3 py-2">
                <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                  Change due
                </span>
                <span className="text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                  ₹{change.toFixed(2)}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button className="btn-secondary flex-1" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary flex-1 text-base py-3"
            onClick={handleConfirm}
            disabled={busy}
          >
            {phase === "creating"
              ? "Saving sale…"
              : phase === "paying"
                ? "Recording payment…"
                : mode === "pending"
                  ? "Save as pending"
                  : mode === "cash"
                    ? "Confirm Cash"
                    : "Confirm UPI"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PayModeTile({
  active,
  onClick,
  label,
  hint,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-1.5 rounded-xl border p-4 text-center transition-all ${
        active
          ? "border-brand-600 bg-brand-600/10 ring-2 ring-brand-600"
          : "border-border bg-surface-2 hover:bg-surface-3"
      }`}
    >
      {icon && (
        <span className={active ? "text-brand-600 dark:text-brand-400" : "text-text-tertiary"}>
          {icon}
        </span>
      )}
      <span className="text-base font-semibold">{label}</span>
      <span className="text-[11px] text-text-tertiary">{hint}</span>
    </button>
  );
}

function QuickAmount({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
    >
      {label}
    </button>
  );
}

// ── Icons ────────────────────────────────────────────────────────

function svgProps(className = "h-6 w-6") {
  return {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
}

function CashIcon() {
  return (
    <svg {...svgProps()}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </svg>
  );
}

function UpiIcon() {
  return (
    <svg {...svgProps()}>
      <rect x="5" y="2" width="14" height="20" rx="2.5" />
      <path d="M11 18h2" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg {...svgProps()}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
