import { renderHook, act } from "@testing-library/react";
import {
  NAV_SHORTCUT_DEFS,
  getActiveShortcuts,
  setShortcutBinding,
  clearShortcutBinding,
  resetShortcutPrefs,
  findBindingConflict,
  bindingEquals,
  formatBinding,
  eventToBinding,
  useShortcutPrefs,
} from "@/hooks/useShortcutPrefs";

const STORAGE_KEY = "hisaabo-nav-shortcuts";

function readStored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
}

describe("useShortcutPrefs", () => {
  beforeEach(() => {
    // The module keeps state across tests — wipe both the store and storage.
    resetShortcutPrefs();
    localStorage.clear();
  });

  // ── Data integrity ──────────────────────────────────────────────────────────

  it("has unique ids and routes for every shortcut definition", () => {
    const ids = NAV_SHORTCUT_DEFS.map((d) => d.id);
    const routes = NAV_SHORTCUT_DEFS.map((d) => d.route);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(routes).size).toBe(routes.length);
  });

  // ── Defaults ────────────────────────────────────────────────────────────────

  it("assigns the documented Ctrl+digit defaults", () => {
    const byId = Object.fromEntries(getActiveShortcuts().map((s) => [s.id, s.binding]));
    expect(byId["nav-dashboard"]).toEqual({ key: "1", ctrl: true });
    expect(byId["nav-sales"]).toEqual({ key: "2", ctrl: true });
    expect(byId["nav-purchases"]).toEqual({ key: "3", ctrl: true });
    expect(byId["nav-settings"]).toEqual({ key: "0", ctrl: true });
  });

  it("leaves secondary shortcuts unassigned by default", () => {
    const byId = Object.fromEntries(getActiveShortcuts().map((s) => [s.id, s]));
    expect(byId["nav-quotations"].binding).toBeNull();
    expect(byId["nav-quotations"].isCustom).toBe(false);
  });

  // ── Mutation + persistence ──────────────────────────────────────────────────

  it("setShortcutBinding overrides a binding and persists it", () => {
    setShortcutBinding("nav-sales", { key: "s", ctrl: true, shift: true });

    const sales = getActiveShortcuts().find((s) => s.id === "nav-sales")!;
    expect(sales.binding).toEqual({ key: "s", ctrl: true, shift: true });
    expect(sales.isCustom).toBe(true);
    expect(readStored()["nav-sales"]).toEqual({ key: "s", ctrl: true, shift: true });
  });

  it("clearShortcutBinding reverts to the default and drops the override", () => {
    setShortcutBinding("nav-sales", { key: "s", ctrl: true });
    clearShortcutBinding("nav-sales");

    const sales = getActiveShortcuts().find((s) => s.id === "nav-sales")!;
    expect(sales.binding).toEqual({ key: "2", ctrl: true });
    expect(sales.isCustom).toBe(false);
    expect(readStored()["nav-sales"]).toBeUndefined();
  });

  it("resetShortcutPrefs restores every default", () => {
    setShortcutBinding("nav-sales", { key: "s", ctrl: true });
    setShortcutBinding("nav-items", { key: "j", ctrl: true });
    resetShortcutPrefs();

    expect(getActiveShortcuts().every((s) => !s.isCustom)).toBe(true);
    expect(readStored()).toEqual({});
  });

  // ── Conflicts + equality ────────────────────────────────────────────────────

  it("findBindingConflict finds the shortcut already holding a binding", () => {
    const conflict = findBindingConflict({ key: "2", ctrl: true });
    expect(conflict?.id).toBe("nav-sales");
  });

  it("findBindingConflict ignores the shortcut being re-bound", () => {
    const conflict = findBindingConflict({ key: "2", ctrl: true }, "nav-sales");
    expect(conflict).toBeUndefined();
  });

  it("bindingEquals is case-insensitive on the key and compares modifiers", () => {
    expect(bindingEquals({ key: "K", ctrl: true }, { key: "k", ctrl: true })).toBe(true);
    expect(bindingEquals({ key: "k", ctrl: true }, { key: "k" })).toBe(false);
  });

  // ── Formatting + event conversion ───────────────────────────────────────────

  it("formatBinding returns modifier tokens followed by the key", () => {
    expect(formatBinding({ key: "2", ctrl: true })).toHaveLength(2);
    expect(formatBinding({ key: "2", ctrl: true }).at(-1)).toBe("2");
    expect(formatBinding({ key: "k", ctrl: true, shift: true })).toHaveLength(3);
    expect(formatBinding({ key: "k", ctrl: true, shift: true }).at(-1)).toBe("K");
  });

  it("eventToBinding ignores modifier-only presses", () => {
    expect(eventToBinding(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }))).toBeNull();
    expect(eventToBinding(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }))).toBeNull();
  });

  it("eventToBinding captures the key and active modifiers", () => {
    const binding = eventToBinding(new KeyboardEvent("keydown", { key: "2", ctrlKey: true }));
    expect(binding).toEqual({ key: "2", ctrl: true, shift: undefined, alt: undefined });
  });

  // ── Reactivity ──────────────────────────────────────────────────────────────

  it("useShortcutPrefs reflects store changes reactively", () => {
    const { result } = renderHook(() => useShortcutPrefs());
    expect(result.current.shortcuts.find((s) => s.id === "nav-sales")!.binding).toEqual({ key: "2", ctrl: true });

    act(() => {
      result.current.setBinding("nav-sales", { key: "s", ctrl: true });
    });

    expect(result.current.shortcuts.find((s) => s.id === "nav-sales")!.binding).toEqual({ key: "s", ctrl: true });
  });
});
