/**
 * GodownsPage.test.tsx — Stock Locations page ("Batches & Serials" tab).
 *
 * WHY THIS FILE EXISTS:
 * Per-godown stock used to be answerable ONLY for items that opted into
 * batch/serial/expiry tracking — the selector silently listed nothing for
 * ordinary items, which is most of a typical business's catalogue. The
 * document engine now writes a nameless quantity bucket per godown for every
 * item, so this page shows the location split for untracked items too.
 *
 * These tests pin exactly that contract:
 *   - every item is selectable, tracked or not;
 *   - an untracked item gets Total/Unattributed stat cards, the
 *     "Stock by godown" split, and the transfer control — but NO lot
 *     machinery (no receive button, no FEFO card, no lots table);
 *   - a tracked item keeps all of the above plus lot detail;
 *   - transferring posts both ends + quantity to inventory.transfer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const { transferMutate, invalidateStub } = vi.hoisted(() => ({
  transferMutate: vi.fn(),
  invalidateStub: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  getBusinessId: () => "biz-1",
  trpc: {
    useUtils: () => ({
      inventory: {
        list: { invalidate: invalidateStub },
        listLots: { invalidate: invalidateStub },
        stockByGodown: { invalidate: invalidateStub },
        expiringSoon: { invalidate: invalidateStub },
      },
      item: { list: { invalidate: invalidateStub } },
    }),
    inventory: {
      list: {
        useQuery: () => ({
          data: [
            { id: "g-main", name: "Main Godown", isPrimary: true },
            { id: "g-shop", name: "Shop Counter", isPrimary: false },
          ],
        }),
      },
      listLots: {
        useQuery: () => ({
          isLoading: false,
          data: [
            {
              id: "lot-1",
              batchNo: "BAG-1",
              serialNo: null,
              godownId: "g-main",
              quantity: "20.000",
              quantityReceived: "25.000",
              quantitySold: "5.000",
              expiryDate: null,
              status: "active",
              deletedAt: null,
            },
          ],
        }),
      },
      stockByGodown: {
        useQuery: () => ({
          data: {
            totalQuantity: "80.000",
            unattributed: "5.000",
            trackingMode: "none",
            breakdown: [
              { godownId: "g-main", godownName: "Main Godown", quantity: "50.000" },
              { godownId: "g-shop", godownName: "Shop Counter", quantity: "30.000" },
            ],
          },
        }),
      },
      allocateFEFO: {
        useQuery: () => ({
          data: {
            plan: [
              { lotId: "lot-1", batchNo: "BAG-1", serialNo: null, expiryDate: null, available: "20.000" },
            ],
          },
        }),
      },
      expiringSoon: { useQuery: () => ({ data: [], isLoading: false }) },
      createLot: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      transfer: { useMutation: () => ({ mutate: transferMutate, isPending: false }) },
      create: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      update: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      setPrimary: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      delete: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    item: {
      list: {
        useQuery: () => ({
          data: {
            data: [
              // Untracked: the whole point of this page's contract.
              { id: "i-plain", name: "Plain Nails", trackingMode: "none" },
              { id: "i-batch", name: "Sugar 1kg", trackingMode: "batch" },
            ],
          },
        }),
      },
    },
  },
}));

vi.mock("@/hooks/useToast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Import after mocks so the component picks up the stubbed trpc.
import { GodownsPage } from "../../routes/godowns";

/** Render the page and land on the "Batches & Serials" (Lots) tab. */
function renderLotsTab() {
  render(<GodownsPage />);
  fireEvent.click(screen.getByRole("button", { name: "Batches & Serials" }));
}

function pickItem(value: string) {
  fireEvent.change(screen.getByLabelText("Item"), { target: { value } });
}

describe("Stock Locations — Batches & Serials tab", () => {
  beforeEach(() => {
    transferMutate.mockClear();
    invalidateStub.mockClear();
  });

  it("offers EVERY item in the selector, including untracked ones", () => {
    renderLotsTab();

    const select = screen.getByLabelText("Item") as HTMLSelectElement;
    expect(select.options).toHaveLength(3); // placeholder + both items
    expect(
      screen.getByRole("option", { name: "Plain Nails — Not tracked" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Sugar 1kg — Batch" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("2 item(s). Pick one to see where its stock sits."),
    ).toBeInTheDocument();
  });

  it("shows the location split for an UNTRACKED item — and no lot machinery", async () => {
    renderLotsTab();
    pickItem("i-plain");

    await waitFor(() =>
      expect(screen.getByText("Stock by godown")).toBeInTheDocument(),
    );

    // Headline + unattributed stat cards.
    expect(screen.getByText("Total stock")).toBeInTheDocument();
    expect(screen.getByText("Unattributed stock")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument(); // unattributed, via qty()

    // The split itself (scoped to the card so transfer <option>s don't
    // duplicate the godown names).
    const card = screen.getByText("Stock by godown").closest<HTMLElement>("div.card")!;
    const list = within(card).getByRole("list");
    expect(within(list).getByText("Main Godown")).toBeInTheDocument();
    // Breakdown rows print the raw decimal (qty() is only used by stat cards).
    expect(within(list).getByText("50.000")).toBeInTheDocument();
    expect(within(list).getByText("Shop Counter")).toBeInTheDocument();
    expect(within(list).getByText("30.000")).toBeInTheDocument();

    // Two godowns → the transfer control is offered for untracked items too.
    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(screen.getByText("Transfer stock between godowns")).toBeInTheDocument();

    // Lot machinery stays hidden: this item has no batch/serial/expiry.
    expect(screen.queryByRole("button", { name: "Receive stock" })).not.toBeInTheDocument();
    expect(screen.queryByText("Next to sell (FEFO)")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("No lot detail for untracked items")).toBeInTheDocument();
  });

  it("keeps the location split for a TRACKED item and adds lot detail", async () => {
    renderLotsTab();
    pickItem("i-batch");

    await waitFor(() =>
      expect(screen.getByText("Stock by godown")).toBeInTheDocument(),
    );

    // Same split as untracked — location is answerable either way.
    const card = screen.getByText("Stock by godown").closest<HTMLElement>("div.card")!;
    expect(within(card).getByText("50.000")).toBeInTheDocument();

    // Lot detail on top.
    expect(screen.getByRole("button", { name: "Receive stock" })).toBeInTheDocument();
    expect(screen.getByText("Next to sell (FEFO)")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("BAG-1")).toBeInTheDocument();
    expect(screen.queryByText("No lot detail for untracked items")).not.toBeInTheDocument();
  });

  it("transfers between the two godowns with both ends and the quantity", async () => {
    renderLotsTab();
    pickItem("i-plain");

    await waitFor(() => expect(screen.getByLabelText("From")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "g-main" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "g-shop" } });
    fireEvent.change(screen.getByLabelText("Qty"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Transfer" }));

    expect(transferMutate).toHaveBeenCalledWith({
      itemId: "i-plain",
      quantity: "12",
      fromGodownId: "g-main",
      toGodownId: "g-shop",
    });
  });

  it("refuses an incomplete transfer without calling the API", async () => {
    renderLotsTab();
    pickItem("i-plain");

    await waitFor(() => expect(screen.getByLabelText("From")).toBeInTheDocument());

    // All three fields blank — the button must fail locally.
    fireEvent.click(screen.getByRole("button", { name: "Transfer" }));
    expect(transferMutate).not.toHaveBeenCalled();
  });
});
