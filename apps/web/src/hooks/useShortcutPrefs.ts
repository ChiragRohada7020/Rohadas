import { useCallback, useMemo, useSyncExternalStore } from "react";

// ── Editable navigation shortcuts ─────────────────────────────────────────────
//
// Every top-level destination in the app gets a keyboard shortcut the user can
// re-bind (default: Ctrl+1 … Ctrl+0). Bindings are persisted to localStorage so
// they survive reloads, and the module-level store keeps every consumer (the
// hotkey registrar and the shortcuts dialog) in sync via useSyncExternalStore.

export interface ShortcutBinding {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface NavShortcutDef {
  /** Stable id used as the localStorage key, e.g. "nav-sales". */
  id: string;
  /** Router path the shortcut navigates to. */
  route: string;
  /** Human label shown in the shortcuts dialog and command palette. */
  label: string;
  /** Sidebar section this item belongs to (used for dialog grouping). */
  group: string;
  /** Default binding; null = the user must assign one. */
  defaultBinding: ShortcutBinding | null;
}

export interface ResolvedNavShortcut extends NavShortcutDef {
  /** Effective binding after applying user overrides. */
  binding: ShortcutBinding | null;
  /** True when the binding comes from the user's saved preferences. */
  isCustom: boolean;
}

// ── Single source of truth for navigable destinations ─────────────────────────

export const NAV_SHORTCUT_DEFS: NavShortcutDef[] = [
  { id: "nav-dashboard",         route: "/",                    label: "Dashboard",           group: "Overview",   defaultBinding: { key: "1", ctrl: true } },
  { id: "nav-sales",             route: "/sales",               label: "Sale Invoices",       group: "Sales",      defaultBinding: { key: "2", ctrl: true } },
  { id: "nav-purchases",         route: "/purchases",           label: "Purchase Invoices",   group: "Purchase",   defaultBinding: { key: "3", ctrl: true } },
  { id: "nav-customers",         route: "/customers",           label: "Customers",           group: "Contacts",   defaultBinding: { key: "4", ctrl: true } },
  { id: "nav-suppliers",         route: "/suppliers",           label: "Suppliers",           group: "Contacts",   defaultBinding: { key: "5", ctrl: true } },
  { id: "nav-items",             route: "/items",               label: "Items",               group: "Inventory",  defaultBinding: { key: "6", ctrl: true } },
  { id: "nav-payments",          route: "/payments",            label: "Payments",            group: "Money",      defaultBinding: { key: "7", ctrl: true } },
  { id: "nav-cash-bank",         route: "/cash-and-bank",       label: "Cash & Bank",         group: "Money",      defaultBinding: { key: "8", ctrl: true } },
  { id: "nav-gst",               route: "/gst",                 label: "GST Reports",         group: "Compliance", defaultBinding: { key: "9", ctrl: true } },
  { id: "nav-settings",          route: "/settings",            label: "Settings",            group: "Overview",   defaultBinding: { key: "0", ctrl: true } },

  // No default binding — the user can assign one.
  { id: "nav-quotations",        route: "/quotations",          label: "Quotations",          group: "Sales",      defaultBinding: null },
  { id: "nav-sales-returns",     route: "/sales-returns",       label: "Sales Returns",       group: "Sales",      defaultBinding: null },
  { id: "nav-credit-notes",      route: "/credit-notes",        label: "Credit Notes",        group: "Sales",      defaultBinding: null },
  { id: "nav-delivery-challans", route: "/delivery-challans",   label: "Delivery Challans",   group: "Sales",      defaultBinding: null },
  { id: "nav-proforma",          route: "/proforma-invoices",   label: "Proforma Invoices",   group: "Sales",      defaultBinding: null },
  { id: "nav-store-orders",      route: "/store-orders",        label: "Store Orders",        group: "Sales",      defaultBinding: null },
  { id: "nav-automated",         route: "/automated-invoices",  label: "Recurring Invoices",  group: "Sales",      defaultBinding: null },
  { id: "nav-godowns",           route: "/godowns",             label: "Stock Locations",     group: "Inventory",  defaultBinding: null },
  { id: "nav-expenses",          route: "/expenses",            label: "Expenses",            group: "Money",      defaultBinding: null },
  { id: "nav-shipments",         route: "/shipments",           label: "Shipments",           group: "Money",      defaultBinding: null },
  { id: "nav-bank-recon",        route: "/bank-reconciliation", label: "Bank Reconciliation", group: "Money",      defaultBinding: null },
  { id: "nav-journal",           route: "/journal-entries",     label: "Journal Entries",     group: "Money",      defaultBinding: null },
  { id: "nav-gstr2b",            route: "/gstr2b",              label: "GSTR-2B Recon",       group: "Compliance", defaultBinding: null },
  { id: "nav-itc",               route: "/itc",                 label: "Input Tax Credit",    group: "Compliance", defaultBinding: null },
  { id: "nav-e-invoicing",       route: "/e-invoicing",         label: "E-Invoicing",         group: "Compliance", defaultBinding: null },
  { id: "nav-eway-bills",        route: "/eway-bills",          label: "E-Way Bills",         group: "Compliance", defaultBinding: null },
  { id: "nav-reports",           route: "/reports",             label: "Reports",             group: "Compliance", defaultBinding: null },
  { id: "nav-pos",               route: "/pos",                 label: "POS",                 group: "Overview",   defaultBinding: null },
];

// ── Persistence ───────────────────────────────────────────────────────────────

const STORAGE_KEY = "hisaabo-nav-shortcuts";

type PrefMap = Record<string, ShortcutBinding>;

function sanitizeBinding(raw: unknown): ShortcutBinding | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.key !== "string" || b.key.length === 0) return null;
  return {
    key: b.key,
    ctrl: b.ctrl === true || undefined,
    shift: b.shift === true || undefined,
    alt: b.alt === true || undefined,
  };
}

function readPrefs(): PrefMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: PrefMap = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const binding = sanitizeBinding(value);
      if (binding) out[id] = binding;
    }
    return out;
  } catch {
    return {};
  }
}

// ── Module-level reactive store ───────────────────────────────────────────────

let prefs: PrefMap = readPrefs();
let version = 0;
const listeners = new Set<() => void>();

function emit() {
  version += 1;
  listeners.forEach((fn) => fn());
}

function persist() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* quota / private mode — in-memory prefs still work for this session */
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion(): number {
  return version;
}

// ── Public mutation API ───────────────────────────────────────────────────────

/** Assign (or overwrite) a binding for one shortcut. */
export function setShortcutBinding(id: string, binding: ShortcutBinding): void {
  prefs = { ...prefs, [id]: binding };
  persist();
  emit();
}

/** Remove a custom binding, reverting to the shortcut's default. */
export function clearShortcutBinding(id: string): void {
  if (!(id in prefs)) return;
  const next = { ...prefs };
  delete next[id];
  prefs = next;
  persist();
  emit();
}

/** Discard every custom binding and restore all defaults. */
export function resetShortcutPrefs(): void {
  prefs = {};
  persist();
  emit();
}

// ── Resolution helpers ────────────────────────────────────────────────────────

/** Merge the saved prefs over the defaults for every known shortcut. */
export function getActiveShortcuts(): ResolvedNavShortcut[] {
  return NAV_SHORTCUT_DEFS.map((def) => {
    const custom = prefs[def.id];
    return {
      ...def,
      binding: custom ?? def.defaultBinding,
      isCustom: !!custom,
    };
  });
}

/** Find a shortcut already using the given binding (optionally excluding one). */
export function findBindingConflict(
  binding: ShortcutBinding,
  excludeId?: string,
): ResolvedNavShortcut | undefined {
  return getActiveShortcuts().find(
    (s) => s.id !== excludeId && s.binding && bindingEquals(s.binding, binding),
  );
}

export function bindingEquals(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return (
    a.key.toLowerCase() === b.key.toLowerCase() &&
    !!a.ctrl === !!b.ctrl &&
    !!a.shift === !!b.shift &&
    !!a.alt === !!b.alt
  );
}

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** Display tokens for a binding, e.g. ["Ctrl", "2"] or ["⌘", "⇧", "K"]. */
export function formatBinding(binding: ShortcutBinding): string[] {
  const keys: string[] = [];
  if (binding.ctrl) keys.push(isMac ? "⌘" : "Ctrl");
  if (binding.alt) keys.push(isMac ? "⌥" : "Alt");
  if (binding.shift) keys.push(isMac ? "⇧" : "Shift");
  keys.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return keys;
}

// ── React hook ────────────────────────────────────────────────────────────────

export interface UseShortcutPrefsResult {
  shortcuts: ResolvedNavShortcut[];
  setBinding: (id: string, binding: ShortcutBinding) => void;
  clearBinding: (id: string) => void;
  reset: () => void;
}

export function useShortcutPrefs(): UseShortcutPrefsResult {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  // `v` is the store version; recompute the resolved list whenever it changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shortcuts = useMemo(() => getActiveShortcuts(), [v]);

  const setBinding = useCallback((id: string, binding: ShortcutBinding) => {
    setShortcutBinding(id, binding);
  }, []);

  const clearBinding = useCallback((id: string) => {
    clearShortcutBinding(id);
  }, []);

  const reset = useCallback(() => {
    resetShortcutPrefs();
  }, []);

  return { shortcuts, setBinding, clearBinding, reset };
}

/**
 * Turn a KeyboardEvent into a binding, or null when the press is only a
 * modifier (which we ignore so the user can keep holding keys).
 */
export function eventToBinding(e: KeyboardEvent): ShortcutBinding | null {
  const key = e.key;
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") {
    return null;
  }
  return {
    key: key.length === 1 ? key.toLowerCase() : key,
    ctrl: e.ctrlKey || e.metaKey || undefined,
    shift: e.shiftKey || undefined,
    alt: e.altKey || undefined,
  };
}
