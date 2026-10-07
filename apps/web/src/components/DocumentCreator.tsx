import { useState, useMemo, useEffect, useId, useRef } from "react";
import { trpc, getBusinessId } from "@/lib/trpc";
import { formatCurrency, cn, todayISODate, toISOString, formatDateInput } from "@/lib/utils";
import dayjs from "dayjs";
import { SlideOver } from "@/components/ui/SlideOver";
import { Combobox } from "@/components/ui/Combobox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/hooks/useToast";
import { useDebounce } from "@/hooks/useDebounce";
import { calcLineItem, calcInvoiceTotals, money } from "@hisaabo/shared";
import { QuickPartyCreate } from "@/components/QuickPartyCreate";
import { QuickItemCreate, type QuickItemCreateResult } from "@/components/QuickItemCreate";

// ── Types ────────────────────────────────────────────────────────

export type DocumentType =
  | "invoice"
  | "quotation"
  | "credit_note"
  | "debit_note"
  | "delivery_challan"
  | "proforma"
  | "sales_return"
  | "purchase_return";

export interface DocumentCreatorProps {
  documentType: DocumentType;
  invoiceType: "sale" | "purchase";
  onClose: () => void;
  /** Called after successful creation/update. Receives the partyId used. */
  onSuccess?: (partyId?: string) => void;
  // Edit mode: pass existing invoice ID to pre-fill
  editInvoiceId?: string;
  // Pre-fill from an existing invoice without entering edit mode (for CN/SR creation)
  prefillFromInvoiceId?: string;
  // Pre-select a party on mount (e.g. "Create another" for same customer)
  initialPartyId?: string;
}

interface UnitOption {
  unit: string;
  salePrice: string;
  conversionFactor: number;
}

/**
 * A selectable `item_variants` row. Mirrors the shape POS uses for its catalog
 * tiles (packages/api/src/routers/pos.ts) so both screens label variants
 * identically — "Item — attr / attr".
 */
interface VariantOption {
  variantId: string;
  label: string;
  salePrice: string;
  purchasePrice: string;
  stockQuantity: string;
}

interface LineItem {
  id: string;
  itemId?: string;
  /**
   * Snapshot of the item name shown as the primary bold line on the invoice.
   * On item-pick this is set to `product.name` and should only change if the
   * user manually edits it. Wire-format key is `itemName` on the tRPC payload.
   */
  itemName: string;
  /**
   * Optional free-text notes for this line (per-invoice comments like
   * "Keep separate from order #42"). Rendered as italic muted secondary text
   * on the invoice detail view and PDF. Max 500 chars (validator-enforced).
   * UI-only key; on submission we map this to the payload's `description`
   * field (which the backend validator accepts as nullable/optional).
   */
  notes: string;
  quantity: string;
  unitPrice: string;
  taxPercent: string;
  discountPercent: string;
  selectedUnit?: string;
  conversionFactor?: string;
  availableUnits?: UnitOption[];
  /**
   * Chosen row from `item_variants` for `itemMode === "variants"` items.
   *
   * Distinct from `selectedUnit`: an alt_units item keeps its units in the
   * `items.unit_variants` JSONB array (→ selectedUnit), whereas a variants item
   * keeps them in the `item_variants` TABLE (→ variantId). The invoice builder
   * previously only ever set the former, so variant items silently fell back to
   * the parent's base price and recorded no variant identity.
   */
  variantId?: string;
  /** Variant rows offered for this line, when the parent item has variants. */
  availableVariants?: VariantOption[];
  /** Frozen "Item — attr / attr" label; set at pick time, matching POS tiles. */
  baseItemName?: string;

  // ── Lot identity, per line ──────────────────────────────────────
  //
  // Only meaningful for an item whose trackingMode is not "none". Sent with
  // every line, but the UI only reveals the inputs a tracked item needs.
  batchNo?: string;
  serialNo?: string;
  /** yyyy-mm-dd from the native date input; converted to ISO on submit. */
  expiryDate?: string;
  /** A specific lot being consumed (a serial-tracked sale). */
  lotId?: string;
}

interface Charge {
  label: string;
  amount: string;
  shipmentId?: string;
}

// ── Helpers ──────────────────────────────────────────────────────

const documentTypeLabels: Record<DocumentType, string> = {
  invoice: "Invoice",
  quotation: "Quotation",
  credit_note: "Credit Note",
  debit_note: "Debit Note",
  delivery_challan: "Delivery Challan",
  proforma: "Proforma Invoice",
  sales_return: "Sales Return",
  purchase_return: "Purchase Return",
};

function newLineItem(): LineItem {
  return {
    id: crypto.randomUUID(),
    itemName: "",
    notes: "",
    quantity: "1",
    unitPrice: "",
    taxPercent: "0",
    discountPercent: "0",
  };
}

function calcLine(li: LineItem) {
  const result = calcLineItem({
    quantity: li.quantity || "0",
    unitPrice: li.unitPrice || "0",
    taxPercent: li.taxPercent || "0",
    discountPercent: li.discountPercent || "0",
  });
  return {
    subtotal: money.toNumber(result.subtotal),
    afterDiscount: money.toNumber(result.afterDiscount),
    taxAmt: money.toNumber(result.taxAmount),
    total: money.toNumber(result.total),
  };
}

// ── Component ────────────────────────────────────────────────────

export function DocumentCreator({
  documentType,
  invoiceType,
  onClose,
  onSuccess,
  editInvoiceId,
  prefillFromInvoiceId,
  initialPartyId,
}: DocumentCreatorProps) {
  const [partyId, setPartyId] = useState(initialPartyId ?? "");
  const [invoiceDate, setInvoiceDate] = useState(todayISODate);
  const [dueDate, setDueDate] = useState(() => dayjs().add(7, "day").format("YYYY-MM-DD"));
  const [dueDateManuallySet, setDueDateManuallySet] = useState(false);
  const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState("");
  const [items, setItems] = useState<LineItem[]>([newLineItem()]);
  const [charges, setCharges] = useState<Charge[]>([]);
  const [invoiceDiscount, setInvoiceDiscount] = useState("0");
  const [invoiceDiscountType, setInvoiceDiscountType] = useState<"amount" | "percent">("amount");
  const [roundOff, setRoundOff] = useState("0");
  // Tracks whether the user has manually edited the Round Off field on this
  // document. Once true we stop applying the per-business "round down to
  // integer" auto-fill so we don't silently undo their override.
  const [roundOffOverridden, setRoundOffOverridden] = useState(false);
  const [referenceDocumentId, _setReferenceDocumentId] = useState<string | undefined>(prefillFromInvoiceId || undefined);

  // ── Stock location (godown) ────────────────────────────────────
  //
  // ONE selector for the whole document, not one per line. This mirrors
  // ERPNext, and it is also just correct: a purchase delivery physically
  // arrives at one place, so asking per row would be both tedious and wrong.
  // The value is stamped onto every line at submit time.
  //
  // Only documents that actually move stock show it. A quotation or proforma
  // has no goods to place, and a credit note is a financial adjustment — so
  // the field is hidden rather than shown-and-ignored.
  const [godownId, setGodownId] = useState("");
  const { data: godowns } = trpc.inventory.list.useQuery();

  // Confirm dialog when closing with unsaved data
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);

  // Ref the date input so we can move focus there as soon as a customer is
  // picked — otherwise Tab cycles back to the customer combobox in the
  // dialog's focus order.
  const dateInputRef = useRef<HTMLInputElement>(null);

  // Active business — used to read defaultRoundOff and defaultTermsAndConditions.
  // The list is already cached by __root.tsx; this query is essentially free.
  const { data: businessList } = trpc.business.list.useQuery();
  const currentBizId = getBusinessId();
  const activeBusiness =
    businessList?.find((b) => b.id === currentBizId) ?? businessList?.[0];
  const bizDefaultTerms = activeBusiness?.defaultTermsAndConditions ?? "";
  const bizDefaultRoundOff = activeBusiness?.defaultRoundOff ?? false;

  // Server-side search for party picker
  const [partySearch, setPartySearch] = useState("");
  const debouncedPartySearch = useDebounce(partySearch, 300);

  const { data: partiesData, isFetching: partiesFetching } = trpc.party.list.useQuery({
    type: invoiceType === "sale" ? "customer" : "supplier",
    search: debouncedPartySearch || undefined,
    page: 1,
    limit: 50,
  });

  // Server-side search for item picker (per line item)
  const [itemSearch, setItemSearch] = useState("");
  const debouncedItemSearch = useDebounce(itemSearch, 300);

  const { data: itemsData, isFetching: itemsFetching } = trpc.item.list.useQuery({
    search: debouncedItemSearch || undefined,
    page: 1,
    limit: 50,
  });

  // Quick-create dialog state
  const [quickPartyOpen, setQuickPartyOpen] = useState(false);
  const [quickPartyName, setQuickPartyName] = useState("");
  const [quickItemOpen, setQuickItemOpen] = useState(false);
  const [quickItemName, setQuickItemName] = useState("");
  const [quickItemLineId, setQuickItemLineId] = useState<string | null>(null);

  const isEditing = !!editInvoiceId;
  const prefillId = editInvoiceId || prefillFromInvoiceId;

  // Pre-fill standard Terms & Conditions from business defaults on new docs
  // only — editing a saved doc must respect what was actually persisted.
  // Runs once when the biz default first becomes available; if the user has
  // already typed something, we don't clobber it.
  const termsHydratedRef = useRef(false);
  useEffect(() => {
    if (isEditing || prefillId) return;
    if (termsHydratedRef.current) return;
    if (!bizDefaultTerms) return;
    if (terms.trim().length > 0) return;
    setTerms(bizDefaultTerms);
    termsHydratedRef.current = true;
  }, [bizDefaultTerms, isEditing, prefillId, terms]);

  // Auto-calculate due date: party's credit period or default 7 days
  useEffect(() => {
    if (dueDateManuallySet || isEditing) return;
    const selectedParty = partiesData?.data.find((p) => p.id === partyId);
    const creditDays = selectedParty?.creditPeriodDays ?? 7;
    const base = dayjs(invoiceDate || todayISODate()).add(creditDays, "day");
    setDueDate(base.format("YYYY-MM-DD"));
  }, [invoiceDate, partyId, partiesData, dueDateManuallySet, isEditing]);

  const utils = trpc.useUtils();

  const { data: editData } = trpc.invoice.getById.useQuery(
    { id: prefillId! },
    { enabled: !!prefillId }
  );

  useEffect(() => {
    if (!editData) return;
    setPartyId(editData.partyId);
    if (isEditing) {
      // Editing: use the document's own date
      setInvoiceDate(formatDateInput(editData.invoiceDate));
      if (editData.dueDate) setDueDate(formatDateInput(editData.dueDate));
    }
    // Prefill from source: keep today's date (already the default)
    setNotes(editData.notes || "");
    setTerms(editData.termsAndConditions || "");
    setRoundOff(editData.roundOff || "0");

    // Pre-fill invoice discount
    if (editData.discountAmount && parseFloat(editData.discountAmount) > 0) {
      setInvoiceDiscount(editData.discountAmount);
      setInvoiceDiscountType("amount"); // stored discount is always an amount
    }

    // Map charges from JSONB
    if (editData.charges && Array.isArray(editData.charges)) {
      setCharges(editData.charges.map((c: any) => ({ label: c.label, amount: c.amount, ...(c.shipmentId ? { shipmentId: c.shipmentId } : {}) })));
    }

    // Map line items — backend now exposes `itemName` (required snapshot)
    // and `description` (nullable free-text notes) as separate fields.
    if (editData.lineItems?.length) {
      setItems(editData.lineItems.map((li: any) => ({
        id: crypto.randomUUID(),
        itemId: li.itemId || undefined,
        itemName: li.itemName ?? "",
        notes: li.description ?? "",
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        taxPercent: li.taxPercent || "0",
        discountPercent: li.discountPercent || "0",
        // Rehydrate the variant selection when editing an existing document,
        // otherwise the variant silently resets to the first/default on save.
        selectedUnit: li.selectedUnit ?? undefined,
        conversionFactor: li.conversionFactor ?? undefined,
        variantId: li.variantId ?? undefined,
      })));
    }
  }, [editData]);

  function invalidateLists() {
    utils.invoice.list.invalidate();
    utils.quotation.list.invalidate();
    utils.creditNote.list.invalidate();
    utils.debitNote.list.invalidate();
    utils.deliveryChallan.list.invalidate();
    utils.proforma.list.invalidate();
    utils.salesReturn.list.invalidate();
    utils.purchaseReturn.list.invalidate();
    utils.dashboard.summary.invalidate();
    utils.dashboard.shippingSummary.invalidate();
    utils.item.list.invalidate();
    if (editInvoiceId) {
      utils.invoice.getById.invalidate({ id: editInvoiceId });
    }
  }

  function handleSuccess() {
    invalidateLists();
    toast.success(isEditing ? `${documentTypeLabels[documentType]} updated` : `${documentTypeLabels[documentType]} created`);
    onSuccess?.(partyId || undefined);
    onClose();
  }

  function handleInvoiceCreateSuccess(data: { invoiceNumber: string }) {
    invalidateLists();
    toast.success(`Invoice ${data.invoiceNumber} created`);
    onSuccess?.(partyId || undefined);
    onClose();
  }

  function handleError(err: { message: string }) {
    toast.error(isEditing ? "Failed to update document" : "Failed to create document", err.message);
  }

  // Dirty detection: snapshot the form once it has settled (after editData
  // applies for edits, or on first mount for new docs) and compare every
  // render. The snapshot is taken in a microtask so React has flushed all
  // setStates triggered by the editData effect before we baseline.
  const formSnapshot = useMemo(
    () => JSON.stringify({
      partyId,
      invoiceDate,
      dueDate,
      notes,
      terms,
      // Strip the random `id` field so re-mounted line items don't appear
      // dirty just because of a fresh UUID.
      items: items.map(({ id: _id, ...rest }) => rest),
      charges,
      invoiceDiscount,
      invoiceDiscountType,
      roundOff,
    }),
    [partyId, invoiceDate, dueDate, notes, terms, items, charges, invoiceDiscount, invoiceDiscountType, roundOff]
  );
  const formSnapshotRef = useRef(formSnapshot);
  formSnapshotRef.current = formSnapshot;
  const baselineRef = useRef<string | null>(null);

  useEffect(() => {
    // Re-baseline whenever editData becomes available (or stays undefined for
    // a new doc). The microtask defer waits for setStates inside the editData
    // effect to land before snapshotting.
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      baselineRef.current = formSnapshotRef.current;
    });
    return () => { cancelled = true; };
  }, [editData]);

  const isDirty =
    baselineRef.current !== null && baselineRef.current !== formSnapshot;

  // All mutation hooks called unconditionally (React rules)
  const invoiceMutation = trpc.invoice.create.useMutation({
    onSuccess: isEditing ? handleSuccess : handleInvoiceCreateSuccess,
    onError: handleError,
  });
  const quotationMutation = trpc.quotation.create.useMutation({
    onSuccess: handleSuccess,
    onError: handleError,
  });
  const creditNoteMutation = trpc.creditNote.create.useMutation({
    onSuccess: handleSuccess,
    onError: handleError,
  });
  const debitNoteMutation = trpc.debitNote.create.useMutation({
    onSuccess: handleSuccess,
    onError: handleError,
  });
  const deliveryChallanMutation = trpc.deliveryChallan.create.useMutation({
    onSuccess: handleSuccess,
    onError: handleError,
  });
  const proformaMutation = trpc.proforma.create.useMutation({
    onSuccess: handleSuccess,
    onError: handleError,
  });
  const salesReturnMutation = trpc.salesReturn.create.useMutation({
    onSuccess: handleSuccess,
    onError: handleError,
  });
  const purchaseReturnMutation = trpc.purchaseReturn.create.useMutation({
    onSuccess: handleSuccess,
    onError: handleError,
  });

  const updateMutation = trpc.invoice.update.useMutation({
    onSuccess: handleSuccess,
    onError: handleError,
  });

  const mutationMap: Record<DocumentType, { mutate: (input: any) => void; isPending: boolean }> = {
    invoice: invoiceMutation,
    quotation: quotationMutation,
    credit_note: creditNoteMutation,
    debit_note: debitNoteMutation,
    delivery_challan: deliveryChallanMutation,
    proforma: proformaMutation,
    sales_return: salesReturnMutation,
    purchase_return: purchaseReturnMutation,
  };

  const createMutation = mutationMap[documentType];
  const activeMutation = isEditing ? updateMutation : createMutation;

  // Computed totals using fixed-point arithmetic
  const totals = useMemo(() => {
    const activeCharges = charges.filter((c) => c.amount && parseFloat(c.amount) > 0);
    const result = calcInvoiceTotals({
      lineItems: items.map((li) => ({
        quantity: li.quantity || "0",
        unitPrice: li.unitPrice || "0",
        taxPercent: li.taxPercent || "0",
        discountPercent: li.discountPercent || "0",
      })),
      charges: activeCharges.map((c) => ({ amount: c.amount })),
      invoiceDiscount: invoiceDiscount || "0",
      invoiceDiscountType,
      roundOff: roundOff || "0",
    });
    return {
      subtotal: money.toNumber(result.subtotal),
      taxTotal: money.toNumber(result.taxTotal),
      lineDiscountTotal: money.toNumber(result.lineDiscountTotal),
      invoiceDiscountAmount: money.toNumber(result.invoiceDiscountAmount),
      chargesTotal: money.toNumber(result.chargesTotal),
      total: money.toNumber(result.total),
    };
  }, [items, charges, invoiceDiscount, invoiceDiscountType, roundOff]);

  // Auto-fill round-off so the grand total floors to a whole rupee, when the
  // business has "round down to integer" enabled. Stops as soon as the user
  // edits the field manually (`roundOffOverridden`) so we never silently
  // override their explicit number.  Edit mode preserves whatever round-off
  // was saved with the original document.
  useEffect(() => {
    if (isEditing) return;
    if (roundOffOverridden) return;
    if (!bizDefaultRoundOff) return;
    const current = parseFloat(roundOff || "0");
    const rawTotal = totals.total - current;
    if (!Number.isFinite(rawTotal)) return;
    const target = (Math.floor(rawTotal) - rawTotal).toFixed(2);
    if (target !== current.toFixed(2)) {
      setRoundOff(target);
    }
  }, [bizDefaultRoundOff, isEditing, roundOffOverridden, totals.total, roundOff]);

  function updateItem(id: string, field: keyof LineItem, value: string) {
    setItems((prev) =>
      prev.map((li) => (li.id === id ? { ...li, [field]: value } : li))
    );
  }

  function selectProduct(lineId: string, productId: string) {
    // Look in current search results; fall back gracefully if not found
    const product = itemsData?.data.find((p) => p.id === productId);
    if (!productId) {
      // Cleared selection
      setItems((prev) =>
        prev.map((li) =>
          li.id === lineId
            ? { ...li, itemId: undefined, availableUnits: undefined, selectedUnit: undefined, conversionFactor: undefined, variantId: undefined, availableVariants: undefined, baseItemName: undefined }
            : li
        )
      );
      return;
    }
    if (!product) return;

    const basePrice = (invoiceType === "sale" ? product.salePrice : product.purchasePrice) || "";
    const baseUnit: UnitOption = { unit: product.unit, salePrice: basePrice, conversionFactor: 1 };
    const variants: UnitOption[] = ((product.unitVariants as any[]) || []).map((v: any) => ({
      unit: v.unit,
      salePrice: invoiceType === "sale" ? v.salePrice : (v.purchasePrice || v.salePrice),
      conversionFactor: v.conversionFactor,
    }));
    const allUnits = [baseUnit, ...variants];

    // Variants live in the `item_variants` TABLE, not the `unit_variants` JSONB
    // array. An item with itemMode="variants" has a NULL unit_variants array,
    // so the code above produced allUnits.length === 1 and the line fell back
    // to the parent's base price with no variant identity recorded.
    const rawVariants: Array<{
      id: string;
      salePrice?: string | null;
      purchasePrice?: string | null;
      stockQuantity?: string | null;
      attributeValues?: unknown;
    }> = ((product as { variants?: unknown }).variants as typeof rawVariants) ?? [];
    const availableVariants: VariantOption[] = rawVariants.map((v) => {
      // Same " / " join POS uses (pos.ts expandItemsToTiles) so both screens
      // label variants identically.
      const attrs = Object.values((v.attributeValues ?? {}) as Record<string, unknown>)
        .filter(Boolean)
        .join(" / ");
      return {
        variantId: v.id,
        label: attrs ? `${product.name} — ${attrs}` : product.name,
        salePrice: v.salePrice ?? product.salePrice ?? "",
        purchasePrice: v.purchasePrice ?? product.purchasePrice ?? "",
        stockQuantity: v.stockQuantity ?? "0",
      };
    });
    // Preselect the first variant so a variant-only item always bills a real
    // variant instead of silently using the parent price.
    const firstVariant = availableVariants[0];
    const variantPrice =
      invoiceType === "sale"
        ? firstVariant?.salePrice
        : (firstVariant?.purchasePrice || firstVariant?.salePrice);

    setItems((prev) =>
      prev.map((li) =>
        li.id === lineId
          ? {
              ...li,
              itemId: product.id,
              // itemName is the frozen snapshot shown as the primary line on
              // the invoice. Notes are intentionally cleared on pick so the
              // new line starts with a blank notes field — users then type a
              // per-invoice comment (e.g. "Keep separate from order #42") if
              // they want one.
              itemName: firstVariant ? firstVariant.label : product.name,
              baseItemName: product.name,
              notes: "",
              unitPrice: variantPrice ?? basePrice,
              taxPercent: product.taxPercent,
              selectedUnit: undefined,
              conversionFactor: undefined,
              availableUnits: allUnits.length > 1 ? allUnits : undefined,
              variantId: firstVariant?.variantId,
              availableVariants: availableVariants.length > 0 ? availableVariants : undefined,
            }
          : li
      )
    );
  }

  function handleSelectVariant(lineId: string, variantId: string) {
    setItems((prev) =>
      prev.map((li) => {
        if (li.id !== lineId) return li;
        const v = li.availableVariants?.find((o) => o.variantId === variantId);
        if (!v) return li;
        return {
          ...li,
          variantId: v.variantId,
          // Refreeze the display label so the line reads "Item — attrs".
          itemName: v.label,
          unitPrice:
            invoiceType === "sale" ? v.salePrice : (v.purchasePrice || v.salePrice),
        };
      })
    );
  }

  function addLine() {
    setItems((prev) => [...prev, newLineItem()]);
  }

  function removeLine(id: string) {
    if (items.length <= 1) return;
    setItems((prev) => prev.filter((li) => li.id !== id));
  }

  function handleSelectUnit(lineId: string, unitKey: string) {
    setItems((prev) =>
      prev.map((li) => {
        if (li.id !== lineId) return li;
        const unit = li.availableUnits?.find((u) =>
          unitKey === "__base__" ? u.conversionFactor === 1 : u.unit === unitKey
        );
        if (!unit) return li;
        return {
          ...li,
          selectedUnit: unitKey === "__base__" ? undefined : unit.unit,
          unitPrice: unit.salePrice,
          conversionFactor: unitKey === "__base__" ? undefined : String(unit.conversionFactor),
        };
      })
    );
  }

  function handleQuickPartyCreated(party: { id: string; name: string }) {
    setPartyId(party.id);
  }

  function handleQuickItemCreated(item: QuickItemCreateResult) {
    if (!quickItemLineId) return;
    const price = invoiceType === "sale" ? item.salePrice : item.purchasePrice;
    setItems((prev) =>
      prev.map((li) =>
        li.id === quickItemLineId
          ? {
              ...li,
              itemId: item.id,
              itemName: item.name,
              notes: "",
              unitPrice: price || "",
              taxPercent: item.taxPercent || "0",
              selectedUnit: undefined,
              conversionFactor: undefined,
              availableUnits: undefined,
              variantId: undefined,
              availableVariants: undefined,
              baseItemName: undefined,
            }
          : li
      )
    );
    setQuickItemLineId(null);
  }

  function handleSubmit() {
    const validItems = items.filter((li) => li.itemName.trim() && li.unitPrice);
    if (validItems.length === 0) {
      toast.error("Add at least one line item with an item name and price");
      return;
    }
    if (!partyId) {
      toast.error(
        `Select a ${invoiceType === "sale" ? "customer" : "supplier"}`
      );
      return;
    }

    // Bug B: the backend validator requires `itemName` (the frozen snapshot
    // shown as the primary bold line) and accepts an optional, nullable
    // `description` (free-text notes rendered underneath). Empty or
    // whitespace-only notes are sent as `undefined` so the validator keeps
    // the stored column NULL instead of persisting an empty string.
    const lineItemsPayload = validItems.map((li) => {
      const trimmedNotes = li.notes.trim();
      return {
        itemId: li.itemId,
        itemName: li.itemName.trim(),
        description: trimmedNotes.length > 0 ? trimmedNotes : undefined,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        taxPercent: li.taxPercent,
        discountPercent: li.discountPercent,
        selectedUnit: li.selectedUnit || undefined,
        conversionFactor: li.conversionFactor || undefined,
        // Required so the API records WHICH variant was billed — without it
        // the server has no variant identity to decrement stock against and
        // the line reopens as a plain item.
        variantId: li.variantId || undefined,
        // The header-level godown, stamped onto each line. Blank stays
        // undefined so the server applies its own default (purchase → primary
        // godown, sale → FEFO across all) rather than storing an empty string.
        godownId: godownId || undefined,
        // Lot identity. Only present for a tracked item; the inputs are
        // hidden otherwise, so these are normally undefined.
        batchNo: li.batchNo?.trim() || undefined,
        serialNo: li.serialNo?.trim() || undefined,
        lotId: li.lotId || undefined,
        // The native date input yields yyyy-mm-dd; the API validator expects a
        // full ISO datetime. Anchor at UTC MIDNIGHT (Z), matching godowns.tsx
        // and the calendar-date storage convention — a local-time parse here
        // would land on 18:30Z the previous day in IST.
        expiryDate: li.expiryDate
          ? `${li.expiryDate}T00:00:00.000Z`
          : undefined,
      };
    });

    const chargesPayload = charges
      .filter((c) => c.label && c.amount && parseFloat(c.amount) > 0)
      .map((c) => ({
        label: c.label,
        amount: parseFloat(c.amount).toFixed(2),
        ...(c.shipmentId ? { shipmentId: c.shipmentId } : {}),
      }));

    if (isEditing) {
      updateMutation.mutate({
        id: editInvoiceId!,
        partyId,
        invoiceDate: toISOString(invoiceDate),
        dueDate: toISOString(dueDate) ?? null,
        notes: notes || null,
        termsAndConditions: terms || null,
        charges: chargesPayload,
        invoiceDiscount: invoiceDiscount || "0",
        invoiceDiscountType,
        roundOff: roundOff || "0",
        lineItems: lineItemsPayload,
      });
    } else {
      createMutation.mutate({
        partyId,
        type: invoiceType,
        invoiceDate: toISOString(invoiceDate),
        dueDate: toISOString(dueDate),
        notes: notes || undefined,
        termsAndConditions: terms || undefined,
        charges: chargesPayload,
        invoiceDiscount: invoiceDiscount || "0",
        invoiceDiscountType,
        roundOff: roundOff || undefined,
        referenceDocumentId: referenceDocumentId || undefined,
        lineItems: lineItemsPayload,
      });
    }
  }

  const label = documentTypeLabels[documentType];
  const partyLabel = invoiceType === "sale" ? "Customer" : "Supplier";

  // ── Where should this godown field sit, and what should it say? ─────
  //
  // Derived from how the document actually moves stock, matching the
  // `stockEffect` each router declares:
  //
  //   purchase invoice / sales_return    → increment  → goods COME IN
  //   sale invoice / delivery_challan    → decrement  → goods GO OUT
  //   purchase_return                    → decrement  → goods GO BACK OUT
  //   quotation / proforma / credit/debit → none      → field hidden
  //
  // Getting the wording wrong here is worse than hiding the field: telling a
  // user a delivery "leaves from" the godown they are about to type would make
  // them record the purchase into the wrong location.
  const godownPlacement = useMemo((): { show: boolean; label: string } => {
    switch (documentType) {
      case "invoice":
        return invoiceType === "purchase"
          ? { show: true, label: "Received in" }
          : { show: true, label: "Dispatch from" };
      case "delivery_challan":
        return { show: true, label: "Dispatch from" };
      case "sales_return":
        return { show: true, label: "Returned to" };
      case "purchase_return":
        return { show: true, label: "Returned from" };
      default:
        return { show: false, label: "" };
    }
  }, [documentType, invoiceType]);

  const showGodownField = godownPlacement.show && (godowns?.length ?? 0) > 0;

  const partyOptions =
    partiesData?.data.map((p) => ({
      value: p.id,
      label: p.name,
      description: p.type === "customer" ? "Customer" : "Supplier",
    })) ?? [];

  const itemOptions =
    itemsData?.data.map((p) => ({
      value: p.id,
      label: p.name,
      description: p.unit ? p.unit : undefined,
    })) ?? [];

  // Stable prefix for accessible line item IDs
  const lineItemIdPrefix = useId();

  // Close-attempt handler — only show the confirm dialog when there's data
  // worth losing. A pristine empty form closes silently.
  function handleCloseAttempt(): boolean {
    if (!isDirty) return true;
    setConfirmCloseOpen(true);
    return false;
  }

  return (
    <>
    <SlideOver
      open={true}
      onClose={onClose}
      onCloseAttempt={handleCloseAttempt}
      title={isEditing ? `Edit ${label}` : `New ${label}`}
      description={isEditing ? `Edit ${invoiceType} ${label.toLowerCase()}` : `Create a new ${invoiceType} ${label.toLowerCase()}`}
      footer={
        <div className="flex justify-end gap-3">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => { if (handleCloseAttempt()) onClose(); }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleSubmit}
            disabled={activeMutation.isPending || !partyId || !items.some((li) => li.itemName.trim() && li.unitPrice)}
          >
            {activeMutation.isPending
              ? isEditing ? "Saving..." : "Creating..."
              : isEditing ? "Save Changes" : `Create ${label}`}
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        {/* Top row: party, dates */}
        <div className="grid grid-cols-[1fr_140px_140px] gap-3">
          <Combobox
            label={partyLabel}
            required
            value={partyId}
            onChange={(id) => {
              setPartyId(id);
              // After picking a party, jump to the date input so Tab order
              // doesn't bounce focus back into the (now-selected) combobox
              // and re-open its dropdown.
              if (id) {
                requestAnimationFrame(() => dateInputRef.current?.focus());
              }
            }}
            options={partyOptions}
            placeholder={`Search ${partyLabel.toLowerCase()}...`}
            emptyMessage={`No ${partyLabel.toLowerCase()}s found`}
            onQueryChange={setPartySearch}
            isLoading={partiesFetching && !!debouncedPartySearch}
            onCreateNew={(q) => {
              setQuickPartyName(q);
              setQuickPartyOpen(true);
            }}
            createNewLabel={`Create ${partyLabel.toLowerCase()}`}
            autoFocus={!isEditing && !partyId}
          />
          <div>
            <label className="label">Date</label>
            <input
              ref={dateInputRef}
              type="date"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
              className="input"
            />
          </div>
          {!["credit_note", "sales_return", "purchase_return"].includes(documentType) && (
            <div>
              <label className="label">Due date</label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => { setDueDate(e.target.value); setDueDateManuallySet(true); }}
                className="input"
              />
            </div>
          )}
        </div>

        {/* Stock location — a document-level field, mirroring ERPNext's
            Target/Source Warehouse on a receipt or transfer. Rendered only for
            documents that move stock, and only once the business has at least
            one godown: a single-location shop should never see the control. */}
        {showGodownField && (
          <div className="max-w-xs">
            <label className="label" htmlFor={`${lineItemIdPrefix}-godown`}>
              {godownPlacement.label}
            </label>
            <select
              id={`${lineItemIdPrefix}-godown`}
              value={godownId}
              onChange={(e) => setGodownId(e.target.value)}
              className="input"
            >
              {/* Blank is a real, meaningful choice, not "unset":
                  goods coming IN fall back to the primary godown on the
                  server, while goods going OUT are allocated FEFO across every
                  godown. The option text says so, so the user is never
                  guessing what blank will do. */}
              <option value="">
                {invoiceType === "purchase" ? "Main godown (default)" : "Any godown (earliest expiry first)"}
              </option>
              {godowns?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                  {g.isPrimary ? " (main)" : ""}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-text-tertiary mt-1">
              {invoiceType === "purchase"
                ? "Applies to every line on this document."
                : "Leave as “Any godown” to sell from wherever stock is held."}
            </p>
          </div>
        )}

        {/* Line items */}
        <div className="space-y-3">
          <p className="text-[11px] font-medium text-text-tertiary uppercase tracking-wide">Line Items</p>

          {items.map((li) => {
            const calc = calcLine(li);
            return (
              <div key={li.id} className="rounded-xl border border-border-light bg-surface-1/50 px-4 py-3 space-y-2">
                {/* Row 1: Product (searchable combobox) + unit selector + delete */}
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <Combobox
                      value={li.itemId || ""}
                      onChange={(productId) => selectProduct(li.id, productId)}
                      options={itemOptions}
                      placeholder="Select product or custom item"
                      emptyMessage="No products found"
                      onQueryChange={setItemSearch}
                      isLoading={itemsFetching && !!debouncedItemSearch}
                      onCreateNew={(q) => {
                        setQuickItemName(q);
                        setQuickItemLineId(li.id);
                        setQuickItemOpen(true);
                      }}
                      createNewLabel="Create item"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeLine(li.id)}
                    disabled={items.length <= 1}
                    className="p-1.5 rounded-lg text-text-tertiary hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/50 disabled:opacity-20 disabled:cursor-not-allowed transition-colors shrink-0 mt-0.5"
                    aria-label="Remove line"
                  >
                    {/* Trash icon — distinct from the combobox's clear-X
                        which sits next to it inside the product picker. */}
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M2.5 4h11" />
                      <path d="M6.5 4V2.5h3V4" />
                      <path d="M3.75 4l.75 9a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1l.75-9" />
                      <path d="M6.5 7v4M9.5 7v4" />
                    </svg>
                  </button>
                </div>

                {/* Variant selector pills — only for items whose variants live
                    in the `item_variants` table (itemMode="variants"). Mutually
                    exclusive with the unit pills above: an item is either
                    variant-based or alt-unit-based, never both. */}
                {li.availableVariants && li.availableVariants.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pl-0.5" role="radiogroup" aria-label="Select variant">
                    {li.availableVariants.map((v) => {
                      const isSelected = li.variantId === v.variantId;
                      // Strip the leading "Item — " so the pill shows just the
                      // attributes (the item name is already on the combobox).
                      const attrs = v.label.replace(/^.*—\s*/, "");
                      const price = invoiceType === "sale" ? v.salePrice : (v.purchasePrice || v.salePrice);
                      return (
                        <button
                          key={v.variantId}
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          onClick={() => handleSelectVariant(li.id, v.variantId)}
                          className={cn(
                            "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border",
                            isSelected
                              ? "bg-brand-600 text-white border-brand-600"
                              : "border-border-light text-text-secondary hover:bg-surface-1"
                          )}
                        >
                          <span>{attrs}</span>
                          <span className={cn("tabular-nums", isSelected ? "text-white/80" : "text-text-tertiary")}>
                            ₹{price}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Unit selector pills — only for items with alt units */}
                {li.availableUnits && li.availableUnits.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1.5 pl-0.5" role="radiogroup" aria-label="Select unit">
                    {li.availableUnits.map((u) => {
                      const isSelected = (u.conversionFactor === 1 && !li.selectedUnit) || li.selectedUnit === u.unit;
                      const isBase = u.conversionFactor === 1;
                      return (
                        <button
                          key={u.unit}
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          onClick={() => handleSelectUnit(li.id, isBase ? "__base__" : u.unit)}
                          className={cn(
                            "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border",
                            isSelected
                              ? "bg-brand-600 text-white border-brand-600"
                              : "border-border-light text-text-secondary hover:bg-surface-1"
                          )}
                        >
                          <span>{u.unit.toUpperCase()}</span>
                          <span className={cn("tabular-nums", isSelected ? "text-white/80" : "text-text-tertiary")}>
                            ₹{u.salePrice}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Item name is set automatically from the picker — no separate
                    input needed. The notes textarea below handles free-text. */}

                {/* Row 3: Numbers grid + total */}
                <div className="flex items-end gap-2">
                  <div className="grid grid-cols-4 gap-2 flex-1">
                    <div>
                      <label
                        htmlFor={`${lineItemIdPrefix}-${li.id}-qty`}
                        className="text-[10px] font-medium text-text-tertiary block mb-0.5"
                      >
                        Qty
                      </label>
                      <input
                        id={`${lineItemIdPrefix}-${li.id}-qty`}
                        type="number"
                        value={li.quantity}
                        onChange={(e) => updateItem(li.id, "quantity", e.target.value)}
                        min="0.001"
                        step="any"
                        aria-label="Quantity"
                        className="input py-1.5 text-sm tabular-nums"
                        placeholder="1"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`${lineItemIdPrefix}-${li.id}-price`}
                        className="text-[10px] font-medium text-text-tertiary block mb-0.5"
                      >
                        Price
                      </label>
                      <input
                        id={`${lineItemIdPrefix}-${li.id}-price`}
                        type="number"
                        value={li.unitPrice}
                        onChange={(e) => updateItem(li.id, "unitPrice", e.target.value)}
                        min="0"
                        step="0.01"
                        aria-label="Unit price"
                        className="input py-1.5 text-sm tabular-nums"
                        placeholder="0.00"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`${lineItemIdPrefix}-${li.id}-tax`}
                        className="text-[10px] font-medium text-text-tertiary block mb-0.5"
                      >
                        Tax %
                      </label>
                      <input
                        id={`${lineItemIdPrefix}-${li.id}-tax`}
                        type="number"
                        value={li.taxPercent}
                        onChange={(e) => updateItem(li.id, "taxPercent", e.target.value)}
                        min="0"
                        step="0.01"
                        aria-label="Tax percent"
                        className="input py-1.5 text-sm tabular-nums"
                        placeholder="0"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`${lineItemIdPrefix}-${li.id}-disc`}
                        className="text-[10px] font-medium text-text-tertiary block mb-0.5"
                      >
                        Disc %
                      </label>
                      <input
                        id={`${lineItemIdPrefix}-${li.id}-disc`}
                        type="number"
                        value={li.discountPercent}
                        onChange={(e) => updateItem(li.id, "discountPercent", e.target.value)}
                        min="0"
                        max="100"
                        step="0.01"
                        aria-label="Discount percent"
                        className="input py-1.5 text-sm tabular-nums"
                        placeholder="0"
                      />
                    </div>
                  </div>
                  <div className="text-right shrink-0 pb-1">
                    <p className="text-[10px] text-text-tertiary mb-0.5">Amount</p>
                    <p className="text-sm font-semibold tabular-nums text-text-primary">
                      {li.unitPrice ? formatCurrency(calc.total) : "—"}
                    </p>
                  </div>
                </div>

                {/* Row 4: Lot identity — shown ONLY for an item that actually
                    uses lot tracking, so nothing extra appears for the ~95% of
                    items that don't.

                    A RECEIPT declares the identity of the goods arriving
                    (batch / expiry). A SALE instead CONSUMES an existing lot,
                    so it offers the serials in stock rather than asking the
                    user to invent a batch number — that would create a lot that
                    already had stock consumed from it. */}
                {(() => {
                  const product = li.itemId
                    ? itemsData?.data.find((p) => p.id === li.itemId)
                    : undefined;
                  const mode = (product?.trackingMode ?? "none") as
                    "none" | "batch" | "serial" | "expiry";
                  if (mode === "none") return null;

                  return (
                    <div
                      className="flex items-center gap-2 flex-wrap pt-1"
                      data-testid={`lot-fields-${li.id}`}
                    >
                      <span className="text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
                        {invoiceType === "purchase" ? "Lot" : "Consume lot"}
                      </span>

                      {invoiceType === "purchase" ? (
                        <>
                          {mode !== "serial" && (
                            <input
                              type="text"
                              value={li.batchNo ?? ""}
                              onChange={(e) => updateItem(li.id, "batchNo", e.target.value)}
                              placeholder="Batch no."
                              aria-label="Batch number"
                              maxLength={100}
                              className="input py-1 text-xs w-36"
                            />
                          )}
                          {mode === "expiry" && (
                            <input
                              type="date"
                              value={li.expiryDate ?? ""}
                              onChange={(e) => updateItem(li.id, "expiryDate", e.target.value)}
                              aria-label="Expiry date"
                              className="input py-1 text-xs"
                            />
                          )}
                          {mode === "serial" && (
                            <input
                              type="text"
                              value={li.serialNo ?? ""}
                              onChange={(e) => updateItem(li.id, "serialNo", e.target.value)}
                              placeholder="Serial no."
                              aria-label="Serial number"
                              maxLength={100}
                              className="input py-1 text-xs w-40"
                            />
                          )}
                        </>
                      ) : mode === "serial" ? (
                        <LotPicker
                          itemId={li.itemId!}
                          variantId={li.variantId}
                          godownId={godownId || undefined}
                          value={li.lotId ?? ""}
                          onChange={(lotId) => updateItem(li.id, "lotId", lotId)}
                        />
                      ) : (
                        <span className="text-[10px] text-text-tertiary">
                          Allocated automatically, earliest expiry first.
                        </span>
                      )}
                    </div>
                  );
                })()}

                {/* Row 5: Free-text notes for this line (optional). Stored
                    on the backend as `invoice_items.description` and
                    rendered as italic muted secondary text on the PDF and
                    detail views beneath the item name. */}
                <div className="relative">
                  <textarea
                    id={`${lineItemIdPrefix}-${li.id}-notes`}
                    value={li.notes}
                    onChange={(e) => updateItem(li.id, "notes", e.target.value)}
                    placeholder="Notes for this line (optional)"
                    aria-label="Line notes"
                    rows={2}
                    maxLength={500}
                    className="input py-1.5 text-xs resize-y min-h-[2.25rem]"
                  />
                  {li.notes.length > 400 && (
                    <p
                      className={`absolute right-2 bottom-1 text-[10px] tabular-nums pointer-events-none ${
                        li.notes.length > 500
                          ? "text-red-500"
                          : "text-text-tertiary"
                      }`}
                      aria-live="polite"
                    >
                      {li.notes.length} / 500
                    </p>
                  )}
                </div>
              </div>
            );
          })}

          {/* Add line button */}
          <button
            type="button"
            onClick={addLine}
            className="w-full py-2.5 rounded-xl border border-dashed border-border-light text-sm font-medium text-brand-600 hover:bg-brand-600/5 hover:border-brand-400 transition-colors"
          >
            + Add line item
          </button>
        </div>

        {/* Totals summary */}
        <div className="flex justify-end">
          <div className="w-80 space-y-2.5">
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Subtotal</span>
              <span className="tabular-nums font-medium text-text-primary">
                {formatCurrency(totals.subtotal)}
              </span>
            </div>
            {totals.lineDiscountTotal > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">Line Discounts</span>
                <span className="tabular-nums text-emerald-600">
                  -{formatCurrency(totals.lineDiscountTotal)}
                </span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Tax</span>
              <span className="tabular-nums text-text-primary">
                {formatCurrency(totals.taxTotal)}
              </span>
            </div>

            {/* Invoice-level discount */}
            <div className="flex justify-between items-center text-sm">
              <div className="flex items-center gap-1.5">
                <span className="text-text-secondary">Discount</span>
                <div className="inline-flex rounded-md border border-border-light overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setInvoiceDiscountType("amount")}
                    className={`px-1.5 py-0.5 text-[10px] font-medium transition-colors ${invoiceDiscountType === "amount" ? "bg-brand-600/[0.1] text-brand-700 dark:text-brand-400" : "text-text-tertiary hover:text-text-secondary"}`}
                  >
                    ₹
                  </button>
                  <button
                    type="button"
                    onClick={() => setInvoiceDiscountType("percent")}
                    className={`px-1.5 py-0.5 text-[10px] font-medium transition-colors ${invoiceDiscountType === "percent" ? "bg-brand-600/[0.1] text-brand-700 dark:text-brand-400" : "text-text-tertiary hover:text-text-secondary"}`}
                  >
                    %
                  </button>
                </div>
              </div>
              <input
                type="number"
                className="input w-28 text-right tabular-nums text-sm py-1"
                value={invoiceDiscount}
                onChange={(e) => setInvoiceDiscount(e.target.value)}
                step="0.01"
                min="0"
                placeholder="0.00"
              />
            </div>
            {totals.invoiceDiscountAmount > 0 && invoiceDiscountType === "percent" && (
              <div className="flex justify-end">
                <span className="text-xs tabular-nums text-emerald-600">
                  -{formatCurrency(totals.invoiceDiscountAmount)}
                </span>
              </div>
            )}

            {/* Charges section */}
            <div className="pt-1">
              {charges.map((charge, idx) => (
                <div key={idx} className="flex justify-between items-center text-sm mb-1.5">
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    {charge.shipmentId ? (
                      <span className="text-xs text-text-tertiary italic truncate">{charge.label} (synced)</span>
                    ) : (
                      <>
                        <input
                          value={charge.label}
                          onChange={(e) => {
                            const next = [...charges];
                            next[idx] = { ...next[idx], label: e.target.value };
                            setCharges(next);
                          }}
                          className="input py-1 text-xs w-28"
                          placeholder="Label"
                        />
                        <button
                          type="button"
                          onClick={() => setCharges(charges.filter((_, i) => i !== idx))}
                          className="text-text-tertiary hover:text-red-500 transition-colors p-0.5"
                          aria-label="Remove charge"
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M4 4l8 8M12 4l-8 8" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                  <input
                    type="number"
                    value={charge.amount}
                    onChange={(e) => {
                      if (charge.shipmentId) return; // synced charges are read-only
                      const next = [...charges];
                      next[idx] = { ...next[idx], amount: e.target.value };
                      setCharges(next);
                    }}
                    readOnly={!!charge.shipmentId}
                    className={`input w-28 text-right tabular-nums py-1 text-xs ${charge.shipmentId ? "opacity-60 cursor-not-allowed" : ""}`}
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                  />
                </div>
              ))}

              {/* Quick-add buttons */}
              <div className="flex items-center gap-1.5 mt-1">
                {!charges.some((c) => c.label.toLowerCase() === "shipping") && (
                  <button
                    type="button"
                    onClick={() => setCharges([...charges, { label: "Shipping", amount: "" }])}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors border border-dashed border-border-light"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M1.5 10h8V4H1.5v6z" />
                      <path d="M9.5 6h2.5l2 2.5V10h-4.5V6z" />
                      <circle cx="4" cy="11.5" r="1" />
                      <circle cx="11.5" cy="11.5" r="1" />
                    </svg>
                    Shipping
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setCharges([...charges, { label: "", amount: "" }])}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors"
                >
                  + Add charge
                </button>
              </div>
            </div>

            {totals.chargesTotal > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">
                  Charges ({charges.filter((c) => parseFloat(c.amount) > 0).length})
                </span>
                <span className="tabular-nums text-text-primary">
                  {formatCurrency(totals.chargesTotal)}
                </span>
              </div>
            )}

            <div className="flex justify-between items-center text-sm">
              <div className="flex items-center gap-1.5">
                <span className="text-text-secondary">Round Off</span>
                {bizDefaultRoundOff && !isEditing && !roundOffOverridden && (
                  <span
                    className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded text-brand-700 dark:text-brand-400 bg-brand-600/[0.1]"
                    title="Auto-rounded down to nearest integer (per Settings → Documents). Edit to override."
                  >
                    Auto
                  </span>
                )}
              </div>
              <input
                type="number"
                className="input w-32 text-right tabular-nums"
                value={roundOff}
                onChange={(e) => {
                  setRoundOff(e.target.value);
                  setRoundOffOverridden(true);
                }}
                step="0.01"
              />
            </div>
            <div className="pt-2 border-t border-border-light flex justify-between">
              <span className="text-sm font-semibold text-text-primary">
                Total
              </span>
              <span className="text-lg font-bold tabular-nums text-text-primary">
                {formatCurrency(totals.total)}
              </span>
            </div>
          </div>
        </div>

        {/* Notes and terms */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="Additional notes for the customer…"
              className="input resize-none"
            />
          </div>
          <div>
            <label className="label">Terms &amp; conditions</label>
            <textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={4}
              placeholder="Payment terms, warranty, etc…"
              className="input resize-none"
            />
          </div>
        </div>
      </div>
    </SlideOver>

    <QuickPartyCreate
      open={quickPartyOpen}
      onClose={() => setQuickPartyOpen(false)}
      onCreated={handleQuickPartyCreated}
      initialName={quickPartyName}
      defaultType={invoiceType === "sale" ? "customer" : "supplier"}
    />

    <QuickItemCreate
      open={quickItemOpen}
      onClose={() => { setQuickItemOpen(false); setQuickItemLineId(null); }}
      onCreated={handleQuickItemCreated}
      initialName={quickItemName}
      invoiceType={invoiceType}
    />

    <ConfirmDialog
      open={confirmCloseOpen}
      title="Discard unsaved changes?"
      description="You have entered information on this document. Closing now will lose those changes."
      confirmLabel="Discard"
      variant="danger"
      onCancel={() => setConfirmCloseOpen(false)}
      onConfirm={() => {
        setConfirmCloseOpen(false);
        // Bypass the dirty guard for this close — the user has confirmed.
        baselineRef.current = formSnapshotRef.current;
        onClose();
      }}
    />
    </>
  );
}
/**
 * LotPicker — choose the specific serial being sold.
 *
 * Only rendered for a SERIAL-tracked item on a stock-OUT document. FEFO would
 * happily consume "whichever unit comes first", but a serialised product (a
 * phone, a laptop, a vehicle) has to stay traceable: a warranty claim must name
 * the exact unit, and a tax audit needs to follow it. So this is an explicit
 * pick rather than an automatic allocation.
 *
 * The godown filter mirrors the header selection, so once a cashier says
 * "Dispatch from: Front Counter", only units actually on that counter are
 * offered — picking a serial that is in the back room would then fail at
 * submit time, which is a far worse experience than not offering it.
 */
function LotPicker({
  itemId,
  variantId,
  godownId,
  value,
  onChange,
}: {
  itemId: string;
  variantId?: string;
  godownId?: string;
  value: string;
  onChange: (lotId: string) => void;
}) {
  const { data, isFetching } = trpc.inventory.listLots.useQuery({
    itemId,
    variantId: variantId ?? undefined,
    godownId: godownId ?? undefined,
    inStockOnly: true,
    limit: 200,
  });

  // listLots returns a bare array of stock_lots rows.
  const lots = data ?? [];

  if (isFetching && lots.length === 0) {
    return <span className="text-[10px] text-text-tertiary">Loading serials…</span>;
  }

  if (lots.length === 0) {
    return (
      <span className="text-[10px] text-text-tertiary">
        No serial in stock here — receive one first.
      </span>
    );
  }

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Serial to consume"
      className="input py-1 text-xs"
    >
      <option value="">Choose serial…</option>
      {lots.map((lot) => (
        <option key={lot.id} value={lot.id}>
          {lot.serialNo ?? lot.batchNo ?? lot.id.slice(0, 8)}
        </option>
      ))}
    </select>
  );
}
