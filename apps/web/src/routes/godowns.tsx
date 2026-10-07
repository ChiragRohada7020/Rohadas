import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { PageHeader } from "@/components/ui/PageHeader";
import { PillTabs } from "@/components/ui/Tabs";
import { Modal } from "@/components/ui/Modal";
import { FormField, InputField } from "@/components/ui/FormField";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatCard } from "@/components/ui/StatCard";
import { toast } from "@/hooks/useToast";

/**
 * `/godowns` — stock locations and lot (batch / serial / expiry) tracking.
 *
 * WHY A DEDICATED PAGE:
 * Lot tracking is opt-in per item, so this is only useful to a subset of
 * businesses. Putting it on the Items list would bury it, and putting it in
 * Settings would hide it from someone whose job is moving stock between a shop
 * and a warehouse. It gets its own entry under INVENTORY.
 *
 * The three tabs answer the three questions this subsystem exists for:
 *   Godowns  — where does stock live?
 *   Lots     — what batch/serial/expiry is here, and how much of it?
 *   Expiring — what will I have to write off if I do nothing?
 */

export const Route = createFileRoute("/godowns")({
  component: GodownsPage,
});

type Tab = "godowns" | "lots" | "expiring";

/** Shared label map so "expiry" reads the same on every screen. */
export const TRACKING_LABELS: Record<string, string> = {
  none: "Not tracked",
  batch: "Batch",
  serial: "Serial",
  expiry: "Batch + expiry",
};

/** Parse a numeric(15,3) string for display, tolerating nulls. */
function qty(value: string | null | undefined): string {
  return parseFloat(value ?? "0").toLocaleString("en-IN", { maximumFractionDigits: 3 });
}

/** Exported for tests; the router mounts it via `Route.options.component`. */
export function GodownsPage() {
  const [tab, setTab] = useState<Tab>("godowns");

  return (
    <div>
      <PageHeader
        title="Stock Locations & Lots"
        description="Track where stock is kept, and which batch, serial or expiry lot it belongs to"
      />

      <div className="mb-6">
        <PillTabs
          tabs={[
            { value: "godowns", label: "Godowns" },
            { value: "lots", label: "Batches & Serials" },
            { value: "expiring", label: "Expiring Soon" },
          ]}
          value={tab}
          onChange={(v) => setTab(v as Tab)}
        />
      </div>

      {tab === "godowns" && <GodownsTab />}
      {tab === "lots" && <LotsTab />}
      {tab === "expiring" && <ExpiringTab />}
    </div>
  );
}

// ── Godowns ─────────────────────────────────────────────────────────────────────

interface GodownDraft {
  id?: string;
  name: string;
  code: string;
  city: string;
  stateCode: string;
}

const EMPTY_DRAFT: GodownDraft = { name: "", code: "", city: "", stateCode: "" };

function GodownsTab() {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState<GodownDraft | null>(null);

  const { data: godowns, isLoading } = trpc.inventory.list.useQuery();

  const invalidate = async () => {
    await utils.inventory.list.invalidate();
    await utils.inventory.stockByGodown.invalidate();
    await utils.inventory.expiringSoon.invalidate();
  };

  const createMutation = trpc.inventory.create.useMutation({
    onSuccess: async () => { await invalidate(); toast.success("Godown created"); setEditing(null); },
    onError: (e) => toast.error(e.message),
  });
  const updateMutation = trpc.inventory.update.useMutation({
    onSuccess: async () => { await invalidate(); toast.success("Godown updated"); setEditing(null); },
    onError: (e) => toast.error(e.message),
  });
  const setPrimaryMutation = trpc.inventory.setPrimary.useMutation({
    onSuccess: async () => { await invalidate(); toast.success("Primary godown updated"); },
    onError: (e) => toast.error(e.message),
  });
  const deleteMutation = trpc.inventory.delete.useMutation({
    onSuccess: async () => { await invalidate(); toast.success("Godown deleted"); },
    onError: (e) => toast.error(e.message),
  });

  function submit() {
    if (!editing || editing.name.trim().length === 0) {
      toast.error("Name is required");
      return;
    }
    const payload = {
      name: editing.name.trim(),
      code: editing.code.trim() || undefined,
      city: editing.city.trim() || undefined,
      stateCode: editing.stateCode.trim() || undefined,
    };
    if (editing.id) updateMutation.mutate({ id: editing.id, data: payload });
    else createMutation.mutate(payload);
  }

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-text-tertiary">
          A godown is any place stock is kept — your main shop, a warehouse, a branch. Stock is still
          counted once overall; godowns only break down where it sits.
        </p>
        <button onClick={() => setEditing({ ...EMPTY_DRAFT })} className="btn-primary shrink-0">
          Add godown
        </button>
      </div>

      {isLoading ? (
        <div className="card px-5 py-4"><p className="text-sm text-text-tertiary">Loading godowns…</p></div>
      ) : !godowns || godowns.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No godowns yet"
            description="Add a godown to break down where your stock sits. Optional — a single-location business can leave this empty."
            action={
              <button onClick={() => setEditing({ ...EMPTY_DRAFT })} className="btn-primary px-3 py-2">
                Add godown
              </button>
            }
          />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th><th>Code</th><th>City</th><th>State</th>
                  <th className="w-48">Actions</th>
                </tr>
              </thead>
              <tbody>
                {godowns.map((g) => (
                  <tr key={g.id}>
                    <td className="text-text-primary font-medium">
                      <span className="flex items-center gap-2">
                        {g.name}
                        {g.isPrimary && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">
                            Primary
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="font-mono text-text-secondary">{g.code || "—"}</td>
                    <td className="text-text-secondary">{g.city || "—"}</td>
                    <td className="text-text-secondary">{g.stateCode || "—"}</td>
                    <td className="text-right">
                      <div className="inline-flex gap-1">
                        {!g.isPrimary && (
                          <button className="btn-ghost text-xs px-2 py-1"
                            onClick={() => setPrimaryMutation.mutate({ id: g.id })}>
                            Make primary
                          </button>
                        )}
                        <button className="btn-ghost text-xs px-2 py-1"
                          onClick={() => setEditing({ id: g.id, name: g.name, code: g.code ?? "", city: g.city ?? "", stateCode: g.stateCode ?? "" })}>
                          Edit
                        </button>
                        <button className="btn-ghost text-xs px-2 py-1 text-red-600 dark:text-red-400"
                          onClick={() => {
                            if (confirm(`Delete "${g.name}"? Only possible if it holds no stock.`)) {
                              deleteMutation.mutate({ id: g.id });
                            }
                          }}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}


      <Modal open={editing !== null} onClose={() => setEditing(null)}
        title={editing?.id ? "Edit godown" : "Add godown"} className="max-w-md">
        {editing && (
          <div className="space-y-4">
            <InputField label="Name" required value={editing.name} placeholder="e.g. Main Shop, Pune Branch"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <InputField label="Code" value={editing.code} placeholder="e.g. MAIN, BR-PUNE"
              onChange={(e) => setEditing({ ...editing, code: e.target.value })} />
            <InputField label="City" value={editing.city}
              onChange={(e) => setEditing({ ...editing, city: e.target.value })} />
            <FormField label="GST state code" htmlFor="godown-state-code">
              <input id="godown-state-code" className="input" maxLength={2} placeholder="27"
                value={editing.stateCode}
                onChange={(e) => setEditing({ ...editing, stateCode: e.target.value.replace(/\D/g, "") })} />
            </FormField>
            <div className="flex justify-end gap-2 pt-2">
              <button className="btn-secondary px-3 py-2" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-primary px-3 py-2" onClick={submit} disabled={saving}>
                {saving ? "Saving…" : editing.id ? "Save changes" : "Create godown"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}



// ── Lots ────────────────────────────────────────────────────────────────────────

interface LotDraft {
  batchNo: string;
  serialNo: string;
  quantity: string;
  unitCost: string;
  expiryDate: string;
  godownId: string;
}

const EMPTY_LOT: LotDraft = {
  batchNo: "", serialNo: "", quantity: "1", unitCost: "", expiryDate: "", godownId: "",
};

function LotsTab() {
  const utils = trpc.useUtils();
  // Empty string means "no item picked yet", which is distinct from an id.
  const [itemId, setItemId] = useState<string>("");
  const [draft, setDraft] = useState<LotDraft | null>(null);
  const [transferFrom, setTransferFrom] = useState("");
  const [transferTo, setTransferTo] = useState("");
  const [transferQty, setTransferQty] = useState("");

  const { data: itemsPage } = trpc.item.list.useQuery({ page: 1, limit: 200 });
  const { data: godowns } = trpc.inventory.list.useQuery();

  const item = itemsPage?.data.find((i) => i.id === itemId) ?? null;
  const trackingMode = item?.trackingMode ?? "none";
  const isTracked = trackingMode !== "none";

  const { data: lots, isLoading: lotsLoading } = trpc.inventory.listLots.useQuery(
    { itemId, inStockOnly: false },
    { enabled: itemId !== "" && isTracked },
  );
  // The godown breakdown is computed from per-godown quantity buckets, which
  // the document engine writes for every item — tracked or not. This is what
  // answers "where is my stock and how much?" for ordinary items too, where
  // unattributed honestly holds whatever predates the buckets.
  const { data: breakdown } = trpc.inventory.stockByGodown.useQuery(
    { itemId },
    { enabled: itemId !== "" },
  );
  // A 1-unit probe is enough to show FEFO ordering without asking the user for
  // a sale quantity they have not decided yet.
  const { data: fefo } = trpc.inventory.allocateFEFO.useQuery(
    { itemId, quantity: "1" },
    { enabled: itemId !== "" && isTracked },
  );

  const createLotMutation = trpc.inventory.createLot.useMutation({
    onSuccess: async () => {
      await invalidateLots();
      toast.success("Stock received into lot");
      setDraft(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const transferMutation = trpc.inventory.transfer.useMutation({
    onSuccess: async () => {
      await invalidateLots();
      toast.success("Stock transferred");
      setTransferQty("");
    },
    onError: (e) => toast.error(e.message),
  });

  async function invalidateLots() {
    await utils.inventory.listLots.invalidate();
    await utils.inventory.stockByGodown.invalidate();
    await utils.inventory.expiringSoon.invalidate();
    await utils.item.list.invalidate();
  }

  // The selector lists every item, not just tracked ones: per-godown stock is
  // recorded for all of them, while lot identity stays behind the isTracked
  // gate everywhere below.
  const selectableItems = itemsPage?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="card px-4 py-4 flex flex-col sm:flex-row sm:items-end gap-4">
        <div className="flex-1">
          <label className="label" htmlFor="lot-item-select">Item</label>
          <select id="lot-item-select" className="input" value={itemId}
            onChange={(e) => setItemId(e.target.value)}>
            <option value="">Select an item…</option>
            {selectableItems.map((i) => (
              <option key={i.id} value={i.id}>{i.name} — {TRACKING_LABELS[i.trackingMode]}</option>
            ))}
          </select>
          <p className="text-xs text-text-tertiary mt-1">
            {selectableItems.length === 0
              ? "No items yet. Create one from the Items page to see its godown stock here."
              : `${selectableItems.length} item(s). Pick one to see where its stock sits.`}
          </p>
        </div>
        {isTracked && (
          <button className="btn-primary shrink-0" onClick={() => setDraft({ ...EMPTY_LOT })}>
            Receive stock
          </button>
        )}
      </div>

      {!itemId ? (
        <div className="card">
          <EmptyState title="Pick an item"
            description="Choose an item to see its batches, serials, expiry dates and godown breakdown." />
        </div>
      ) : !isTracked ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StatCard size="md" label="Total stock"
              value={qty(breakdown?.totalQuantity)} note={TRACKING_LABELS[trackingMode]} />
            <StatCard size="md" label="Unattributed stock"
              value={qty(breakdown?.unattributed)}
              note="Stock not yet placed in any godown" />
          </div>

          {/* Untracked items get the location split without any lot baggage:
              no batches, no serials, no FEFO — just "where and how much". */}
          <div className="card px-4 py-3">
            <h3 className="text-sm font-semibold text-text-primary mb-2">Stock by godown</h3>
            {(breakdown?.breakdown ?? []).length === 0 ? (
              <p className="text-sm text-text-tertiary">No godown holds this item yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {breakdown!.breakdown.map((b) => (
                  <li key={b.godownId ?? "none"} className="flex items-center justify-between text-sm">
                    <span className="text-text-secondary">{b.godownName}</span>
                    <span className="tabular-nums font-medium text-text-primary">{b.quantity}</span>
                  </li>
                ))}
              </ul>
            )}
            {(godowns ?? []).length > 1 && (
              <div className="mt-4 pt-3 border-t border-border-light">
                <p className="text-xs text-text-tertiary mb-2">Transfer stock between godowns</p>
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <label className="label" htmlFor="transfer-from">From</label>
                    <select id="transfer-from" className="input w-40" value={transferFrom}
                      onChange={(e) => setTransferFrom(e.target.value)}>
                      <option value="">Choose…</option>
                      {(godowns ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="transfer-to">To</label>
                    <select id="transfer-to" className="input w-40" value={transferTo}
                      onChange={(e) => setTransferTo(e.target.value)}>
                      <option value="">Choose…</option>
                      {(godowns ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="transfer-qty">Qty</label>
                    <input id="transfer-qty" className="input w-24" value={transferQty}
                      onChange={(e) => setTransferQty(e.target.value)} placeholder="0" />
                  </div>
                  <button className="btn-secondary px-3 py-2" disabled={transferMutation.isPending}
                    onClick={() => {
                      if (!transferFrom || !transferTo || !transferQty) {
                        toast.error("Pick both godowns and a quantity");
                        return;
                      }
                      transferMutation.mutate({
                        itemId, quantity: transferQty,
                        fromGodownId: transferFrom, toGodownId: transferTo,
                      });
                    }}>
                    {transferMutation.isPending ? "Moving…" : "Transfer"}
                  </button>
                </div>
                <p className="text-xs text-text-tertiary mt-2">
                  A transfer moves where stock sits. Your total stock does not change.
                </p>
              </div>
            )}
          </div>
          <div className="card">
            <EmptyState
              title="No lot detail for untracked items"
              description="Batch, serial and expiry tracking is opt-in. Edit the item and set its tracking mode to record lots on top of this location split."
            />
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard size="md" label="Total stock"
              value={qty(breakdown?.totalQuantity)} note={TRACKING_LABELS[trackingMode]} />
            <StatCard size="md" label="Lots on hand"
              value={String((lots ?? []).filter((l) => parseFloat(l.quantity) > 0 && !l.deletedAt).length)}
              note="Batches or serial units" />
            <StatCard size="md" label="Unattributed stock"
              value={qty(breakdown?.unattributed)}
              note="Stock held before tracking was switched on" />
          </div>

          {parseFloat(breakdown?.unattributed ?? "0") > 0 && (
            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 px-4 py-2">
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {qty(breakdown?.unattributed)} units of this item are not covered by any lot — they were
                on hand before tracking was switched on. Receive them into a lot, or write them off, so
                the godown breakdown matches the real shelf.
              </p>
            </div>
          )}

          {/* Godown breakdown + FEFO order */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card px-4 py-3">
              <h3 className="text-sm font-semibold text-text-primary mb-2">Stock by godown</h3>
              {(breakdown?.breakdown ?? []).length === 0 ? (
                <p className="text-sm text-text-tertiary">No godown holds this item yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {breakdown!.breakdown.map((b) => (
                    <li key={b.godownId ?? "none"} className="flex items-center justify-between text-sm">
                      <span className="text-text-secondary">{b.godownName}</span>
                      <span className="tabular-nums font-medium text-text-primary">{b.quantity}</span>
                    </li>
                  ))}
                </ul>
              )}
              {(godowns ?? []).length > 1 && (
                <div className="mt-4 pt-3 border-t border-border-light">
                  <p className="text-xs text-text-tertiary mb-2">Transfer stock between godowns</p>
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <label className="label" htmlFor="transfer-from">From</label>
                      <select id="transfer-from" className="input w-40" value={transferFrom}
                        onChange={(e) => setTransferFrom(e.target.value)}>
                        <option value="">Choose…</option>
                        {(godowns ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="label" htmlFor="transfer-to">To</label>
                      <select id="transfer-to" className="input w-40" value={transferTo}
                        onChange={(e) => setTransferTo(e.target.value)}>
                        <option value="">Choose…</option>
                        {(godowns ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="label" htmlFor="transfer-qty">Qty</label>
                      <input id="transfer-qty" className="input w-24" value={transferQty}
                        onChange={(e) => setTransferQty(e.target.value)} placeholder="0" />
                    </div>
                    <button className="btn-secondary px-3 py-2" disabled={transferMutation.isPending}
                      onClick={() => {
                        if (!transferFrom || !transferTo || !transferQty) {
                          toast.error("Pick both godowns and a quantity");
                          return;
                        }
                        transferMutation.mutate({
                          itemId, quantity: transferQty,
                          fromGodownId: transferFrom, toGodownId: transferTo,
                        });
                      }}>
                      {transferMutation.isPending ? "Moving…" : "Transfer"}
                    </button>
                  </div>
                  <p className="text-xs text-text-tertiary mt-2">
                    A transfer moves where stock sits. Your total stock does not change.
                  </p>
                </div>
              )}
            </div>

            <div className="card px-4 py-3">
              <h3 className="text-sm font-semibold text-text-primary mb-1">Next to sell (FEFO)</h3>
              <p className="text-xs text-text-tertiary mb-2">
                Expiry-tracked items sell whichever lot expires soonest first.
              </p>
              {!fefo || fefo.plan.length === 0 ? (
                <p className="text-sm text-text-tertiary">No usable lots with stock on hand.</p>
              ) : (
                <ol className="space-y-1.5">
                  {fefo.plan.slice(0, 5).map((p, i) => (
                    <li key={p.lotId} className="flex items-center justify-between text-sm">
                      <span className="text-text-secondary">
                        <span className="text-text-tertiary mr-1.5">{i + 1}.</span>
                        <span className="font-mono">{p.batchNo || p.serialNo || "Unnamed lot"}</span>
                        {p.expiryDate && (
                          <span className="ml-2 text-xs text-text-tertiary">
                            exp {new Date(p.expiryDate).toLocaleDateString("en-IN")}
                          </span>
                        )}
                      </span>
                      <span className="tabular-nums text-text-primary">{qty(p.available)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>


          {/* Lots table */}
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-border-light">
              <h3 className="text-sm font-semibold text-text-primary">Lots</h3>
            </div>
            {lotsLoading ? (
              <div className="px-4 py-4"><p className="text-sm text-text-tertiary">Loading lots…</p></div>
            ) : (lots ?? []).length === 0 ? (
              <div className="px-4 py-6">
                <p className="text-sm text-text-tertiary">
                  No lots yet. Use &quot;Receive stock&quot; to record the first batch or serial.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Batch / Serial</th><th>Godown</th>
                      <th className="text-right">On hand</th><th className="text-right">Received</th>
                      <th className="text-right">Sold</th><th>Expiry</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(lots ?? []).map((l) => (
                      <tr key={l.id}>
                        <td className="font-mono text-text-primary">{l.batchNo || l.serialNo || "—"}</td>
                        <td className="text-text-secondary">
                          {godowns?.find((g) => g.id === l.godownId)?.name ?? "Unassigned"}
                        </td>
                        <td className="text-right tabular-nums text-text-primary font-medium">{qty(l.quantity)}</td>
                        <td className="text-right tabular-nums text-text-secondary">{qty(l.quantityReceived)}</td>
                        <td className="text-right tabular-nums text-text-secondary">{qty(l.quantitySold)}</td>
                        <td className="text-text-secondary">
                          {l.expiryDate ? new Date(l.expiryDate).toLocaleDateString("en-IN") : "—"}
                        </td>
                        <td className="text-text-secondary">{l.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}


      {/* Receive stock into a lot */}
      <Modal open={draft !== null} onClose={() => setDraft(null)} title="Receive stock into a lot" className="max-w-md">
        {draft && (
          <div className="space-y-4">
            <p className="text-xs text-text-tertiary">{item?.name} — {TRACKING_LABELS[trackingMode]}</p>

            {trackingMode === "serial" ? (
              <InputField label="Serial number" required value={draft.serialNo}
                placeholder="e.g. IMEI-SN-0001"
                onChange={(e) => setDraft({ ...draft, serialNo: e.target.value })} />
            ) : (
              <>
                <InputField label="Batch number" required={trackingMode === "batch"} value={draft.batchNo}
                  placeholder="e.g. TS-AUG26"
                  onChange={(e) => setDraft({ ...draft, batchNo: e.target.value })} />
                <InputField label="Quantity" required value={draft.quantity}
                  onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />
              </>
            )}

            {trackingMode === "expiry" && (
              <FormField label="Expiry date" required htmlFor="lot-expiry">
                <input id="lot-expiry" type="date" className="input" value={draft.expiryDate}
                  onChange={(e) => setDraft({ ...draft, expiryDate: e.target.value })} />
              </FormField>
            )}

            <FormField label="Godown" htmlFor="lot-godown">
              <select id="lot-godown" className="input" value={draft.godownId}
                onChange={(e) => setDraft({ ...draft, godownId: e.target.value })}>
                <option value="">Primary godown (default)</option>
                {(godowns ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </FormField>

            <InputField label="Unit cost" value={draft.unitCost} placeholder="Optional"
              onChange={(e) => setDraft({ ...draft, unitCost: e.target.value })} />

            {trackingMode === "serial" && (
              <p className="text-xs text-text-tertiary">
                A serial-tracked unit is always quantity 1 — record one lot per serial number.
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button className="btn-secondary px-3 py-2" onClick={() => setDraft(null)}>Cancel</button>
              <button className="btn-primary px-3 py-2" disabled={createLotMutation.isPending}
                onClick={() => {
                  if (trackingMode === "serial" && draft.serialNo.trim() === "") {
                    toast.error("Serial number is required"); return;
                  }
                  if (trackingMode === "expiry" && draft.expiryDate === "") {
                    toast.error("Expiry date is required"); return;
                  }
                  if (trackingMode !== "serial" && parseFloat(draft.quantity) <= 0) {
                    toast.error("Quantity must be greater than zero"); return;
                  }
                  createLotMutation.mutate({
                    itemId,
                    quantity: trackingMode === "serial" ? "1" : draft.quantity,
                    batchNo: draft.batchNo.trim() || undefined,
                    serialNo: draft.serialNo.trim() || undefined,
                    expiryDate: draft.expiryDate
                      ? new Date(draft.expiryDate + "T00:00:00.000Z").toISOString()
                      : undefined,
                    godownId: draft.godownId || undefined,
                    unitCost: draft.unitCost.trim() || undefined,
                  });
                }}>
                {createLotMutation.isPending ? "Saving…" : "Receive stock"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}


// ── Expiring soon ───────────────────────────────────────────────────────────────

function ExpiringTab() {
  const [withinDays, setWithinDays] = useState(30);

  const { data: rows, isLoading } = trpc.inventory.expiringSoon.useQuery({ withinDays, limit: 200 });

  const expired = (rows ?? []).filter((r) => r.alreadyExpired);
  const soon = (rows ?? []).filter((r) => !r.alreadyExpired);

  return (
    <div className="space-y-4">
      <div className="card px-4 py-4 flex flex-col sm:flex-row sm:items-end gap-4">
        <div>
          <label className="label" htmlFor="expiry-window">Show lots expiring within</label>
          <select id="expiry-window" className="input w-48" value={withinDays}
            onChange={(e) => setWithinDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
            <option value={180}>6 months</option>
            <option value={365}>1 year</option>
          </select>
        </div>
        <p className="text-sm text-text-tertiary sm:ml-auto sm:text-right">
          Sell or write off near-expiry stock before it becomes a loss.
        </p>
      </div>

      {expired.length > 0 && (
        <ExpiryTable
          title="Already expired"
          tone="red"
          rows={expired}
        />
      )}

      <ExpiryTable
        title={`Expiring within ${withinDays} days`}
        tone={soon.length > 0 ? "amber" : "plain"}
        rows={soon}
        loading={isLoading}
      />
    </div>
  );
}

function ExpiryTable({
  title,
  tone,
  rows,
  loading = false,
}: {
  title: string;
  tone: "red" | "amber" | "plain";
  rows: Array<{
    id: string;
    itemName: string;
    batchNo: string | null;
    quantity: string;
    godownName: string | null;
    expiryDate: Date | null;
    daysRemaining: number | null;
    alreadyExpired: boolean;
  }>;
  loading?: boolean;
}) {
  if (loading) {
    return <div className="card px-5 py-4"><p className="text-sm text-text-tertiary">Loading…</p></div>;
  }
  if (rows.length === 0) return null;

  return (
    <div className="card overflow-hidden">
      <div className={`px-4 py-3 border-b border-border-light ${tone === "red" ? "bg-red-50 dark:bg-red-950/20" : tone === "amber" ? "bg-amber-50 dark:bg-amber-950/20" : "bg-surface-1"}`}>
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Item</th><th>Batch</th><th>Godown</th>
              <th className="text-right">Quantity</th><th>Expiry</th><th className="text-right">Days left</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="text-text-primary font-medium">{r.itemName}</td>
                <td className="font-mono text-text-secondary">{r.batchNo || "—"}</td>
                <td className="text-text-secondary">{r.godownName ?? "Unassigned"}</td>
                <td className="text-right tabular-nums text-text-primary">{qty(r.quantity)}</td>
                <td className="text-text-secondary">
                  {r.expiryDate ? new Date(r.expiryDate).toLocaleDateString("en-IN") : "—"}
                </td>
                <td className="text-right tabular-nums">
                  <span className={r.alreadyExpired
                    ? "font-semibold text-red-600 dark:text-red-400"
                    : (r.daysRemaining ?? 99) <= 30
                      ? "font-medium text-amber-600 dark:text-amber-400"
                      : "text-text-secondary"}>
                    {r.alreadyExpired ? "Expired" : (r.daysRemaining ?? "—")}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

