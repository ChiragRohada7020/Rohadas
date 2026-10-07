/**
 * DocumentCreator — Bug B (Stage 3) + Bug C (Stage 4)
 *
 * These tests cover:
 *
 * Bug B — itemName / description split:
 *   - `itemName` is populated from `product.name` when an item is picked,
 *     and frozen on the invoice line so later renames don't rewrite
 *     historical invoices.
 *   - `description` carries the user's free-text notes. Empty or
 *     whitespace-only notes become `undefined` so the backend keeps the
 *     column NULL instead of persisting "".
 *
 * Bug C — AltUnitSelector pill row:
 *   - Items with `itemMode === "alt_units"` and at least one unitVariant
 *     get a horizontal pill row below the product combobox.
 *   - Clicking a variant pill swaps `unitPrice` and stores `conversionFactor`.
 *   - Clicking the base-unit pill reverts to base price and clears CF.
 *   - Submission payload carries the stored `conversionFactor` directly
 *     (no longer derived dynamically from `availableUnits`).
 *
 * tRPC is mocked so the tests run without a real API server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ─── tRPC mock surface ────────────────────────────────────────────────────

// vi.mock factories are hoisted to the top of the file, so we can't
// reference normal top-level vars inside them. vi.hoisted() is the
// official escape hatch — it runs BEFORE the hoisted factories so the
// references are available at mock-initialisation time.
const { invoiceCreateMutate, quotationCreateMutate, invalidateStub, businessListQuery } =
  vi.hoisted(() => ({
    invoiceCreateMutate: vi.fn(),
    quotationCreateMutate: vi.fn(),
    invalidateStub: vi.fn(),
    businessListQuery: vi.fn(() => ({
      data: [
        {
          id: "biz-1",
          name: "Test Business",
          defaultRoundOff: false,
          defaultTermsAndConditions: null as string | null,
        },
      ],
      isFetching: false,
    })),
  }));

vi.mock("@/lib/trpc", () => ({
  getBusinessId: () => "biz-1",
  trpc: {
    business: {
      list: {
        useQuery: () => businessListQuery(),
      },
    },
    party: {
      list: {
        useQuery: () => ({
          data: {
            data: [
              {
                id: "party-1",
                name: "Ramesh Traders",
                type: "customer",
                creditPeriodDays: 7,
              },
              // A supplier, so purchase-side tests can select a party — the
              // party combobox is labelled by party type (Supplier vs Customer).
              {
                id: "party-2",
                name: "Northwind Suppliers",
                type: "supplier",
                creditPeriodDays: 0,
              },
            ],
          },
          isFetching: false,
        }),
        invalidate: invalidateStub,
      },
      create: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
    item: {
      list: {
        useQuery: () => ({
          data: {
            data: [
              {
                id: "item-1",
                name: "Steel Rod",
                salePrice: "1000",
                purchasePrice: "800",
                taxPercent: "18",
                itemMode: "standard",
                unit: "kg",
                unitVariants: [],
              },
              {
                id: "item-2",
                name: "Cement Bag",
                salePrice: "350",
                purchasePrice: "300",
                taxPercent: "5",
                itemMode: "standard",
                unit: "bag",
                unitVariants: [],
              },
              {
                id: "item-3",
                name: "Rice Basmati",
                salePrice: "100",
                purchasePrice: "80",
                taxPercent: "5",
                itemMode: "alt_units",
                unit: "kg",
                unitVariants: [
                  { unit: "packet", conversionFactor: 0.2, salePrice: "20" },
                ],
              },
              // ── Lot-tracked fixtures ──────────────────────────────
              // Present so the conditional lot row can be exercised: an
              // untracked item must render NOTHING extra, while a tracked
              // one must reveal the inputs its mode actually needs.
              {
                id: "item-4",
                name: "Sunflower Oil",
                salePrice: "140",
                purchasePrice: "120",
                taxPercent: "5",
                itemMode: "standard",
                unit: "bottle",
                unitVariants: [],
                trackingMode: "expiry",
              },
              {
                id: "item-5",
                name: "Circuit Board",
                salePrice: "2400",
                purchasePrice: "1900",
                taxPercent: "18",
                itemMode: "standard",
                unit: "pcs",
                unitVariants: [],
                trackingMode: "serial",
              },
            ],
          },
          isFetching: false,
        }),
        invalidate: invalidateStub,
      },
      create: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
    invoice: {
      create: {
        useMutation: () => ({ mutate: invoiceCreateMutate, isPending: false }),
      },
      update: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      getById: {
        useQuery: () => ({ data: null }),
      },
      list: { invalidate: invalidateStub },
    },
    quotation: {
      create: {
        useMutation: () => ({ mutate: quotationCreateMutate, isPending: false }),
      },
      list: { invalidate: invalidateStub },
    },
    creditNote: {
      create: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      list: { invalidate: invalidateStub },
    },
    debitNote: {
      create: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      list: { invalidate: invalidateStub },
    },
    deliveryChallan: {
      create: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      list: { invalidate: invalidateStub },
    },
    proforma: {
      create: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      list: { invalidate: invalidateStub },
    },
    salesReturn: {
      create: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      list: { invalidate: invalidateStub },
    },
    purchaseReturn: {
      create: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      list: { invalidate: invalidateStub },
    },
    dashboard: {
      summary: { invalidate: invalidateStub },
      shippingSummary: { invalidate: invalidateStub },
    },
    // Inventory namespace used by DocumentCreator's document-level godown
    // selector (and the serial LotPicker for serial-tracked items).
    inventory: {
      list: {
        useQuery: () => ({
          data: [
            { id: "godown-main", name: "Main Godown", isPrimary: true },
            { id: "godown-shop", name: "Shop Counter", isPrimary: false },
          ],
        }),
      },
      listLots: {
        useQuery: () => ({ data: [], isFetching: false }),
      },
    },
    useUtils: () => ({
      invoice: {
        list: { invalidate: invalidateStub },
        getById: { invalidate: invalidateStub },
      },
      quotation: { list: { invalidate: invalidateStub } },
      creditNote: { list: { invalidate: invalidateStub } },
      debitNote: { list: { invalidate: invalidateStub } },
      deliveryChallan: { list: { invalidate: invalidateStub } },
      proforma: { list: { invalidate: invalidateStub } },
      salesReturn: { list: { invalidate: invalidateStub } },
      purchaseReturn: { list: { invalidate: invalidateStub } },
      dashboard: {
        summary: { invalidate: invalidateStub },
        shippingSummary: { invalidate: invalidateStub },
      },
      item: { list: { invalidate: invalidateStub } },
    }),
  },
}));

vi.mock("@/hooks/useToast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after the mocks so the component picks up the stubbed trpc.
import { DocumentCreator } from "../DocumentCreator";
import { toast } from "@/hooks/useToast";

function renderCreator(props: Partial<React.ComponentProps<typeof DocumentCreator>> = {}) {
  return render(
    <DocumentCreator
      documentType="invoice"
      invoiceType="sale"
      onClose={vi.fn()}
      {...props}
    />
  );
}

function getFirstNotesTextarea() {
  return screen.getAllByPlaceholderText(
    "Notes for this line (optional)"
  )[0] as HTMLTextAreaElement;
}

/** Pick a party from the customer combobox. */
async function pickParty(user: ReturnType<typeof userEvent.setup>) {
  const partyCombobox = screen.getByRole("combobox", { name: /customer/i });
  await user.click(partyCombobox);
  await user.click(screen.getByText("Ramesh Traders"));
}

/** Pick the supplier from the combobox — purchase-side forms label it "Supplier". */
async function pickSupplier(user: ReturnType<typeof userEvent.setup>) {
  const partyCombobox = screen.getByRole("combobox", { name: /supplier/i });
  await user.click(partyCombobox);
  await user.click(screen.getByText("Northwind Suppliers"));
}

/** Pick "Steel Rod" (item-1) from the product combobox. */
async function pickSteelRod(user: ReturnType<typeof userEvent.setup>) {
  const combobox = screen.getByPlaceholderText("Select product or custom item");
  await user.click(combobox);
  const option = await screen.findByRole("option", { name: /steel rod/i });
  await user.click(option);
}

/**
 * Pick any product by name. `lineIndex` selects which line's combobox to open —
 * defaulting to the first, which covers most tests, while multi-line tests need
 * to reach a specific row. Empty lines are dropped from the submit payload, so
 * a second line has to be given a product before it counts.
 */
async function pickProduct(
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
  lineIndex = 0
) {
  const comboboxes = screen.getAllByPlaceholderText(
    "Select product or custom item"
  );
  await user.click(comboboxes[lineIndex]);
  const option = await screen.findByRole("option", { name });
  await user.click(option);
}

/**
 * How many line rows expose the lot row (`data-testid="lot-fields-<id>"`).
 * The row is conditional on the item's trackingMode, so 0 means "nothing
 * rendered for untracked items" — which is the behaviour worth pinning.
 */
function lotRowCount() {
  return document.querySelectorAll("[data-testid^='lot-fields-']").length;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("DocumentCreator — Bug B itemName / description split", () => {
  beforeEach(() => {
    invoiceCreateMutate.mockClear();
    quotationCreateMutate.mockClear();
    invalidateStub.mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
  });

  describe("form structure", () => {
    it("renders a notes textarea below each line item (no separate item-name input — name comes from picker)", () => {
      renderCreator();

      // No standalone "Item name *" input — name is set from the product picker.
      expect(screen.queryByPlaceholderText("Item name *")).not.toBeInTheDocument();

      // The notes textarea IS present for free-text line comments.
      const notes = screen.getAllByPlaceholderText("Notes for this line (optional)");
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[0].tagName).toBe("TEXTAREA");
    });
  });

  describe("item pick — sets itemName automatically, notes start empty", () => {
    it("selecting a product from the combobox auto-fills itemName and leaves notes blank", async () => {
      renderCreator();
      const user = userEvent.setup();
      await pickSteelRod(user);

      // Notes should be blank after item pick.
      const notesInput = getFirstNotesTextarea();
      expect(notesInput.value).toBe("");
    });
  });

  describe("notes input behaviour", () => {
    it("typing into the notes textarea updates only notes, not the item name in the payload", async () => {
      renderCreator();
      const user = userEvent.setup();
      await pickParty(user);
      await pickSteelRod(user);

      const notesInput = getFirstNotesTextarea();
      fireEvent.change(notesInput, { target: { value: "Keep separate from order #42" } });
      expect(notesInput.value).toBe("Keep separate from order #42");

      // Submit and check the payload carries both fields independently.
      const submit = screen.getByRole("button", { name: /create invoice/i });
      await user.click(submit);

      await waitFor(() => expect(invoiceCreateMutate).toHaveBeenCalledTimes(1));
      const payload = invoiceCreateMutate.mock.calls[0][0];
      expect(payload.lineItems[0].itemName).toBe("Steel Rod");
      expect(payload.lineItems[0].description).toBe("Keep separate from order #42");
    });

    it("shows a 500-char counter once the notes exceed 400 characters (soft warning zone)", () => {
      renderCreator();
      const notesInput = getFirstNotesTextarea();

      fireEvent.change(notesInput, { target: { value: "a".repeat(100) } });
      expect(screen.queryByText(/\/ 500/)).not.toBeInTheDocument();

      fireEvent.change(notesInput, { target: { value: "a".repeat(450) } });
      expect(screen.getByText("450 / 500")).toBeInTheDocument();
    });

    it("the notes textarea enforces a 500-character maximum via maxLength", () => {
      renderCreator();
      const notesInput = getFirstNotesTextarea();
      expect(notesInput.maxLength).toBe(500);
    });
  });

  describe("submission payload — itemName from picker, description from notes", () => {
    async function primeInvoiceWithItem(notes?: string) {
      const user = userEvent.setup();
      await pickParty(user);
      await pickSteelRod(user);

      if (notes !== undefined) {
        const notesInput = getFirstNotesTextarea();
        fireEvent.change(notesInput, { target: { value: notes } });
      }
      return user;
    }

    it("sends itemName from the picked product and description from notes", async () => {
      renderCreator();
      const user = await primeInvoiceWithItem("Keep separate from order #42");

      const submit = screen.getByRole("button", { name: /create invoice/i });
      await user.click(submit);

      await waitFor(() => expect(invoiceCreateMutate).toHaveBeenCalledTimes(1));
      const payload = invoiceCreateMutate.mock.calls[0][0];
      expect(payload.lineItems).toHaveLength(1);
      expect(payload.lineItems[0].itemName).toBe("Steel Rod");
      expect(payload.lineItems[0].description).toBe("Keep separate from order #42");
    });

    it("omits description when notes are empty so the DB column stays NULL", async () => {
      renderCreator();
      const user = await primeInvoiceWithItem();

      const submit = screen.getByRole("button", { name: /create invoice/i });
      await user.click(submit);

      await waitFor(() => expect(invoiceCreateMutate).toHaveBeenCalledTimes(1));
      const payload = invoiceCreateMutate.mock.calls[0][0];
      expect(payload.lineItems[0].itemName).toBe("Steel Rod");
      expect(payload.lineItems[0].description).toBeUndefined();
    });

    it("omits description when notes are only whitespace", async () => {
      renderCreator();
      const user = await primeInvoiceWithItem("   \n\t  ");

      const submit = screen.getByRole("button", { name: /create invoice/i });
      await user.click(submit);

      await waitFor(() => expect(invoiceCreateMutate).toHaveBeenCalledTimes(1));
      expect(invoiceCreateMutate.mock.calls[0][0].lineItems[0].description).toBeUndefined();
    });
  });

  describe("create button disabled state", () => {
    it("create button is disabled when no party is selected", () => {
      renderCreator();
      const submit = screen.getByRole("button", { name: /create invoice/i });
      expect(submit).toBeDisabled();
    });

    it("create button is disabled when party is selected but no item picked", async () => {
      renderCreator();
      const user = userEvent.setup();
      await pickParty(user);

      const submit = screen.getByRole("button", { name: /create invoice/i });
      expect(submit).toBeDisabled();
    });

    it("create button becomes enabled when party + item are both selected", async () => {
      renderCreator();
      const user = userEvent.setup();
      await pickParty(user);
      await pickSteelRod(user);

      const submit = screen.getByRole("button", { name: /create invoice/i });
      expect(submit).not.toBeDisabled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug C — AltUnitSelector pill row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Selects "Rice Basmati" (item-3, an alt_units item) from the first line's
 * product combobox by clicking it open and choosing the option.
 *
 * The product Combobox has no label prop so we find it via placeholder text
 * (which maps to the underlying input's placeholder attribute).
 */
async function selectRiceBasmati() {
  const user = userEvent.setup();
  // The product Combobox uses placeholder="Select product or custom item".
  const combobox = screen.getByPlaceholderText("Select product or custom item");
  await user.click(combobox);
  // The Combobox renders matching options in a listbox; find the Rice option.
  const option = await screen.findByRole("option", { name: /rice basmati/i });
  await user.click(option);
  return user;
}

describe("DocumentCreator — Bug C AltUnitSelector pill row", () => {
  beforeEach(() => {
    invoiceCreateMutate.mockClear();
    invalidateStub.mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it("renders pill row for an item with alt units", async () => {
    renderCreator();
    await selectRiceBasmati();

    const radiogroup = await screen.findByRole("radiogroup", { name: /select unit/i });
    expect(radiogroup).toBeInTheDocument();
    const pills = screen.getAllByRole("radio");
    expect(pills.length).toBe(2); // KG (base) + PACKET (variant)
  });

  it("each pill shows unit name and price", async () => {
    renderCreator();
    await selectRiceBasmati();

    // Base unit pill
    const kgPill = await screen.findByRole("radio", { name: /KG/i });
    expect(kgPill).toBeInTheDocument();
    expect(kgPill.textContent).toMatch(/KG/i);
    expect(kgPill.textContent).toMatch(/100/);

    // Variant pill
    const packetPill = screen.getByRole("radio", { name: /PACKET/i });
    expect(packetPill.textContent).toMatch(/PACKET/i);
    expect(packetPill.textContent).toMatch(/20/);
  });

  it("base unit pill is selected by default (aria-checked=true)", async () => {
    renderCreator();
    await selectRiceBasmati();

    const kgPill = await screen.findByRole("radio", { name: /KG/i });
    expect(kgPill).toHaveAttribute("aria-checked", "true");

    const packetPill = screen.getByRole("radio", { name: /PACKET/i });
    expect(packetPill).toHaveAttribute("aria-checked", "false");
  });

  it("clicking a variant pill swaps the unit price input to the variant price", async () => {
    renderCreator();
    const user = await selectRiceBasmati();

    // Initially price should be ₹100 (base)
    const priceInput = screen.getAllByLabelText("Unit price")[0] as HTMLInputElement;
    expect(priceInput.value).toBe("100");

    // Click the PACKET pill
    const packetPill = await screen.findByRole("radio", { name: /PACKET/i });
    await user.click(packetPill);

    expect(priceInput.value).toBe("20");
  });

  it("clicking a variant pill marks it as selected (aria-checked=true) and deselects base", async () => {
    renderCreator();
    const user = await selectRiceBasmati();

    const packetPill = await screen.findByRole("radio", { name: /PACKET/i });
    await user.click(packetPill);

    expect(packetPill).toHaveAttribute("aria-checked", "true");
    const kgPill = screen.getByRole("radio", { name: /KG/i });
    expect(kgPill).toHaveAttribute("aria-checked", "false");
  });

  it("clicking base-unit pill after a variant reverts price to base price", async () => {
    renderCreator();
    const user = await selectRiceBasmati();

    // Select variant first
    const packetPill = await screen.findByRole("radio", { name: /PACKET/i });
    await user.click(packetPill);

    const priceInput = screen.getAllByLabelText("Unit price")[0] as HTMLInputElement;
    expect(priceInput.value).toBe("20");

    // Revert to base
    const kgPill = screen.getByRole("radio", { name: /KG/i });
    await user.click(kgPill);

    expect(priceInput.value).toBe("100");
  });

  it("submission payload carries conversionFactor from stored state (not derived)", async () => {
    renderCreator();
    const user = await selectRiceBasmati();

    // Pick the party
    const partyCombobox = screen.getByRole("combobox", { name: /customer/i });
    await user.click(partyCombobox);
    await user.click(screen.getByText("Ramesh Traders"));

    // Select PACKET variant
    const packetPill = await screen.findByRole("radio", { name: /PACKET/i });
    await user.click(packetPill);

    const submit = screen.getByRole("button", { name: /create invoice/i });
    await user.click(submit);

    await waitFor(() => {
      expect(invoiceCreateMutate).toHaveBeenCalledTimes(1);
    });

    const payload = invoiceCreateMutate.mock.calls[0][0];
    expect(payload.lineItems[0].selectedUnit).toBe("packet");
    expect(payload.lineItems[0].conversionFactor).toBe("0.2");
  });

  it("submission payload has no conversionFactor when base unit is selected", async () => {
    renderCreator();
    const user = await selectRiceBasmati();

    // Pick the party
    const partyCombobox = screen.getByRole("combobox", { name: /customer/i });
    await user.click(partyCombobox);
    await user.click(screen.getByText("Ramesh Traders"));

    // Leave on base unit (default after item pick)
    const submit = screen.getByRole("button", { name: /create invoice/i });
    await user.click(submit);

    await waitFor(() => {
      expect(invoiceCreateMutate).toHaveBeenCalledTimes(1);
    });

    const payload = invoiceCreateMutate.mock.calls[0][0];
    expect(payload.lineItems[0].conversionFactor).toBeUndefined();
    expect(payload.lineItems[0].selectedUnit).toBeUndefined();
  });

  it("no pill row rendered for a single-unit item (Steel Rod)", async () => {
    renderCreator();
    const user = userEvent.setup();

    // Select Steel Rod (standard, no unitVariants)
    const combobox = screen.getByPlaceholderText("Select product or custom item");
    await user.click(combobox);
    const option = await screen.findByRole("option", { name: /steel rod/i });
    await user.click(option);

    // No radiogroup should appear
    expect(screen.queryByRole("radiogroup", { name: /select unit/i })).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Confirm-close on dirty form
// ─────────────────────────────────────────────────────────────────────────────

describe("DocumentCreator — confirm-close on dirty form", () => {
  beforeEach(() => {
    invoiceCreateMutate.mockClear();
    invalidateStub.mockClear();
    vi.mocked(toast.error).mockClear();
    businessListQuery.mockReturnValue({
      data: [
        {
          id: "biz-1",
          name: "Test Business",
          defaultRoundOff: false,
          defaultTermsAndConditions: null,
        },
      ],
      isFetching: false,
    });
  });

  it("pristine close fires onClose directly without showing confirm dialog", async () => {
    const onClose = vi.fn();
    renderCreator({ onClose });

    // Wait for the baseline microtask to settle
    await waitFor(() => {});

    // Click the Cancel footer button on a pristine (untouched) form
    const cancelBtn = screen.getByRole("button", { name: /^cancel$/i });
    fireEvent.click(cancelBtn);

    // onClose fires immediately — no confirm dialog
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard unsaved changes?")).not.toBeInTheDocument();
  });

  it("typing in a line's notes marks the form dirty and shows confirm dialog on Cancel", async () => {
    const onClose = vi.fn();
    renderCreator({ onClose });

    // Wait for the baseline microtask to settle
    await waitFor(() => {});

    // Type into the first line notes textarea to mark dirty
    const notesInput = getFirstNotesTextarea();
    fireEvent.change(notesInput, { target: { value: "abc" } });

    // Click Cancel
    const cancelBtn = screen.getByRole("button", { name: /^cancel$/i });
    fireEvent.click(cancelBtn);

    // Confirm dialog should appear, onClose should NOT have been called yet
    expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clicking Discard on the confirm dialog fires onClose and removes the dialog", async () => {
    const onClose = vi.fn();
    renderCreator({ onClose });

    // Wait for the baseline microtask to settle
    await waitFor(() => {});

    // Make form dirty
    const notesInput = getFirstNotesTextarea();
    fireEvent.change(notesInput, { target: { value: "abc" } });

    // Click Cancel to open confirm dialog
    const cancelBtn = screen.getByRole("button", { name: /^cancel$/i });
    fireEvent.click(cancelBtn);

    // Wait for the confirm dialog
    await screen.findByText("Discard unsaved changes?");

    // Click the "Discard" button inside the dialog
    const discardBtn = screen.getByRole("button", { name: /^discard$/i });
    fireEvent.click(discardBtn);

    // onClose must fire and the dialog must disappear
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard unsaved changes?")).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto round-off from business default
// ─────────────────────────────────────────────────────────────────────────────

/** Locate the Round Off number input.
 * JSX structure:
 *   outer div.flex.justify-between
 *     inner div.flex.items-center (span "Round Off" + optional Auto badge)
 *     input[type="number"]
 * We go: span → parent inner div → parent outer div → querySelector input
 */
function getRoundOffInput(): HTMLInputElement {
  const span = screen.getByText("Round Off");
  // span.parentElement = inner "flex items-center gap-1.5" div
  // span.parentElement.parentElement = outer "flex justify-between" div
  const outerDiv = span.parentElement?.parentElement;
  const input = outerDiv?.querySelector('input[type="number"]') as HTMLInputElement | null;
  if (!input) throw new Error("Could not locate Round Off input");
  return input;
}

describe("DocumentCreator — auto round-off from business default", () => {
  beforeEach(() => {
    invoiceCreateMutate.mockClear();
    invalidateStub.mockClear();
    vi.mocked(toast.error).mockClear();
    // Enable defaultRoundOff for all tests in this block
    businessListQuery.mockReturnValue({
      data: [
        {
          id: "biz-1",
          name: "Test Business",
          defaultRoundOff: true,
          defaultTermsAndConditions: null,
        },
      ],
      isFetching: false,
    });
  });

  afterEach(() => {
    // Restore default
    businessListQuery.mockReturnValue({
      data: [
        {
          id: "biz-1",
          name: "Test Business",
          defaultRoundOff: false,
          defaultTermsAndConditions: null,
        },
      ],
      isFetching: false,
    });
  });

  it("auto-fills round-off so the grand total floors to a whole rupee", async () => {
    renderCreator();
    const user = userEvent.setup();
    await pickSteelRod(user);

    // Change unit price to 100.25 → with 18% tax, pre-round total ≈ 118.295
    // round-off should auto-fill to a non-zero value to floor the total
    const priceInput = screen.getAllByLabelText("Unit price")[0] as HTMLInputElement;
    fireEvent.change(priceInput, { target: { value: "100.25" } });

    // Wait for the auto-fill effect to run
    await waitFor(() => {
      const roInput = getRoundOffInput();
      expect(roInput.value).not.toBe("0");
    });

    const roundOffInput = getRoundOffInput();
    // round-off value must be non-zero (auto-filled to floor the total)
    expect(roundOffInput.value).not.toBe("0");
  });

  it("'Auto' badge appears next to Round Off label when bizDefaultRoundOff is on and user hasn't overridden", async () => {
    renderCreator();

    // The Auto badge should appear once the component renders with defaultRoundOff: true
    await waitFor(() => {
      expect(screen.getByText("Auto")).toBeInTheDocument();
    });

    // Both "Round Off" text and "Auto" badge should be visible
    expect(screen.getByText("Round Off")).toBeInTheDocument();
    expect(screen.getByText("Auto")).toBeInTheDocument();
  });

  it("editing the Round Off input manually stops auto-fill and hides the Auto badge", async () => {
    renderCreator();

    // Confirm Auto badge is present initially
    await waitFor(() => {
      expect(screen.getByText("Auto")).toBeInTheDocument();
    });

    // Manually edit the round-off input
    const roundOffInput = getRoundOffInput();
    fireEvent.change(roundOffInput, { target: { value: "5" } });

    // Auto badge should disappear
    await waitFor(() => {
      expect(screen.queryByText("Auto")).not.toBeInTheDocument();
    });

    // Further changes to price should NOT re-populate round-off
    const priceInput = screen.getAllByLabelText("Unit price")[0] as HTMLInputElement;
    fireEvent.change(priceInput, { target: { value: "200" } });

    // Round-off stays at what the user set ("5"), auto-fill doesn't override
    await waitFor(() => {
      expect(getRoundOffInput().value).toBe("5");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T&C pre-fill from business default
// ─────────────────────────────────────────────────────────────────────────────

describe("DocumentCreator — T&C pre-fill from business default", () => {
  const DEFAULT_TERMS = "Payment due within 15 days";

  beforeEach(() => {
    invoiceCreateMutate.mockClear();
    invalidateStub.mockClear();
    vi.mocked(toast.error).mockClear();
    // Enable defaultTermsAndConditions for all tests in this block
    businessListQuery.mockReturnValue({
      data: [
        {
          id: "biz-1",
          name: "Test Business",
          defaultRoundOff: false,
          defaultTermsAndConditions: DEFAULT_TERMS as string | null,
        },
      ],
      isFetching: false,
    });
  });

  afterEach(() => {
    // Restore default
    businessListQuery.mockReturnValue({
      data: [
        {
          id: "biz-1",
          name: "Test Business",
          defaultRoundOff: false,
          defaultTermsAndConditions: null,
        },
      ],
      isFetching: false,
    });
  });

  it("terms textarea pre-fills from bizDefaultTerms on a new doc", async () => {
    renderCreator();

    const termsTextarea = screen.getByPlaceholderText("Payment terms, warranty, etc…") as HTMLTextAreaElement;

    await waitFor(() => {
      expect(termsTextarea.value).toBe(DEFAULT_TERMS);
    });
  });

  it("terms textarea does NOT re-populate if user has already typed something", async () => {
    renderCreator();

    const termsTextarea = screen.getByPlaceholderText("Payment terms, warranty, etc…") as HTMLTextAreaElement;

    // Immediately type into terms before the effect fires
    fireEvent.change(termsTextarea, { target: { value: "hand-written terms" } });

    // Wait a tick for any effects
    await waitFor(() => {});

    // The user's input should be preserved, not overwritten by the default
    expect(termsTextarea.value).toBe("hand-written terms");
  });

  it("terms does NOT pre-fill when prefillFromInvoiceId is passed (prefill mode)", async () => {
    // prefillFromInvoiceId puts the form in prefill mode (prefillId is set),
    // which causes the termsHydratedRef guard to skip hydration.
    renderCreator({ prefillFromInvoiceId: "some-invoice-id" });

    const termsTextarea = screen.getByPlaceholderText("Payment terms, warranty, etc…") as HTMLTextAreaElement;

    // Wait for any async effects
    await waitFor(() => {});

    // Terms should remain empty — editData returns null (mocked), so setTerms
    // stays at "" and the hydration effect is blocked by prefillId guard.
    expect(termsTextarea.value).toBe("");
  });
});

// ─── Stock location (godown) + per-line lot fields ─────────────────────────
//
// ERPNext puts Target/Source Warehouse on the document, not on each row —
// one location is chosen up front and stamped onto every line. These tests
// pin that shape, plus the conditional lot row that receipts use to declare
// lot identity and sales use to consume it.

describe("DocumentCreator — stock location & lot fields", () => {
  beforeEach(() => {
    invoiceCreateMutate.mockClear();
    quotationCreateMutate.mockClear();
    invalidateStub.mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
  });

  describe("header godown selector — shown only where stock actually moves", () => {
    it("labels a sale invoice 'Dispatch from'", () => {
      renderCreator();
      expect(screen.getByLabelText("Dispatch from")).toBeInTheDocument();
    });

    it("labels a purchase invoice 'Received in'", () => {
      renderCreator({ invoiceType: "purchase" });
      expect(screen.getByLabelText("Received in")).toBeInTheDocument();
    });

    it("is hidden on a quotation — no stock moves, so no location is offered", () => {
      renderCreator({ documentType: "quotation" });
      expect(screen.queryByLabelText("Dispatch from")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Received in")).not.toBeInTheDocument();
    });

    it("offers the blank choice plus every location the business has", () => {
      renderCreator();
      const select = screen.getByLabelText("Dispatch from") as HTMLSelectElement;

      // Blank is meaningful (FEFO everywhere), not a disabled placeholder.
      expect(select.options[0].textContent).toMatch(
        /Any godown \(earliest expiry first\)/
      );
      expect(select.options.length).toBe(3); // blank + 2 mock godowns
      expect(screen.getByRole("option", { name: /Main Godown/ })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: /Shop Counter/ })).toBeInTheDocument();
    });

    it("explains what leaving it blank will do", () => {
      renderCreator();
      expect(
        screen.getByText(/Leave as “Any godown” to sell from wherever stock is held\./)
      ).toBeInTheDocument();
    });
  });

  describe("godownId is stamped onto every line", () => {
    it("copies the chosen location to all lines, not just the first", async () => {
      renderCreator();
      const user = userEvent.setup();

      await pickParty(user);
      await pickSteelRod(user);

      // Add a second line so "every line" is actually testable. Every row
      // carries its own remove button, which makes it a reliable row count.
      await user.click(screen.getByRole("button", { name: /add line item/i }));
      await waitFor(() =>
        expect(screen.getAllByLabelText("Remove line").length).toBe(2)
      );
      // A line with no product is treated as unfinished and dropped from the
      // payload, so give the new row an item before asserting on it.
      await pickProduct(user, /cement bag/i, 1);

      const select = screen.getByLabelText("Dispatch from") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "godown-shop" } });

      await user.click(screen.getByRole("button", { name: /create invoice/i }));
      await waitFor(() => expect(invoiceCreateMutate).toHaveBeenCalledTimes(1));

      const lines = invoiceCreateMutate.mock.calls[0][0].lineItems;
      expect(lines.length).toBe(2);
      for (const line of lines) {
        expect(line.godownId).toBe("godown-shop");
      }
    });

    it("omits godownId when left blank so the server applies its own default", async () => {
      renderCreator();
      const user = userEvent.setup();

      await pickParty(user);
      await pickSteelRod(user);
      await user.click(screen.getByRole("button", { name: /create invoice/i }));

      await waitFor(() => expect(invoiceCreateMutate).toHaveBeenCalledTimes(1));
      const lines = invoiceCreateMutate.mock.calls[0][0].lineItems;
      expect(lines[0].godownId).toBeUndefined();
    });
  });

  describe("lot fields are conditional on the item's trackingMode", () => {
    it("renders nothing for an untracked item", async () => {
      renderCreator({ invoiceType: "purchase" });
      const user = userEvent.setup();
      await pickProduct(user, /steel rod/i);
      expect(lotRowCount()).toBe(0);
    });

    it("receipt shows batch + expiry inputs for an expiry-tracked item", async () => {
      renderCreator({ invoiceType: "purchase" });
      const user = userEvent.setup();
      await pickProduct(user, /sunflower oil/i);

      expect(lotRowCount()).toBe(1);
      expect(screen.getByLabelText("Batch number")).toBeInTheDocument();
      expect(screen.getByLabelText("Expiry date")).toBeInTheDocument();
      // Serial input belongs to serial-tracked items only.
      expect(screen.queryByLabelText("Serial number")).not.toBeInTheDocument();
    });

    it("receipt shows a serial input for a serial-tracked item", async () => {
      renderCreator({ invoiceType: "purchase" });
      const user = userEvent.setup();
      await pickProduct(user, /circuit board/i);

      expect(screen.getByLabelText("Serial number")).toBeInTheDocument();
      // A serialised receipt records identity, not expiry.
      expect(screen.queryByLabelText("Expiry date")).not.toBeInTheDocument();
    });

    it("sends the typed batch + expiry as a full ISO datetime", async () => {
      renderCreator({ invoiceType: "purchase" });
      const user = userEvent.setup();
      await pickSupplier(user);
      await pickProduct(user, /sunflower oil/i);

      fireEvent.change(screen.getByLabelText("Batch number"), {
        target: { value: "BATCH-42" },
      });
      fireEvent.change(screen.getByLabelText("Expiry date"), {
        target: { value: "2027-06-30" },
      });

      await user.click(screen.getByRole("button", { name: /create invoice/i }));
      await waitFor(() => expect(invoiceCreateMutate).toHaveBeenCalledTimes(1));

      const line = invoiceCreateMutate.mock.calls[0][0].lineItems[0];
      expect(line.batchNo).toBe("BATCH-42");
      // zod validates `expiryDate` with `.datetime()`, so a bare YYYY-MM-DD
      // would be rejected server-side. Assert the shape, not the exact
      // instant — the machine's time zone decides the date part of the ISO.
      expect(line.expiryDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("never asks the user to type a serial on a sale — it offers a picker", async () => {
      renderCreator();
      const user = userEvent.setup();
      await pickProduct(user, /circuit board/i);

      // No free-text serial field on the outbound side…
      expect(screen.queryByLabelText("Serial number")).not.toBeInTheDocument();
      // …and the picker is mounted in its place (stock comes back empty from
      // the mock, so it states that plainly rather than showing a blank box).
      expect(lotRowCount()).toBe(1);
      expect(screen.getByText(/No serial in stock here/i)).toBeInTheDocument();
    });

    it("sale of a batch item says allocation is automatic (FEFO)", async () => {
      renderCreator();
      const user = userEvent.setup();
      await pickProduct(user, /sunflower oil/i);

      expect(
        screen.getByText(/Allocated automatically, earliest expiry first\./)
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Batch number")).not.toBeInTheDocument();
    });
  });
});
