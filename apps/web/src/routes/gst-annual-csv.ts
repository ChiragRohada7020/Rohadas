/**
 * CSV / row helpers for the CA handover pack.
 *
 * NOTE: do not round-trip this through PowerShell Get-Content/Set-Content. It
 * decodes as Windows-1252 and re-encodes as UTF-8, silently turning en dashes
 * into mojibake. Use the editor tool or Node.
 */

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (headers: string[], rows: unknown[][]): string =>
  [
    headers.map(csvCell).join(","),
    ...rows.map((r) => r.map(csvCell).join(",")),
  ].join("\n");

export const isArr = (v: unknown): v is unknown[] => Array.isArray(v);

export const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

export type Row = Record<string, unknown>;

export const rowsOf = (o: Record<string, unknown>, k: string): Row[] =>
  isArr(o[k]) ? (o[k] as Row[]) : [];

export const pick =
  (...keys: string[]) =>
  (r: Row): unknown[] =>
    keys.map((k) => r[k]);

/**
 * The README is the most valuable file in the pack: without it a CA receives a
 * dozen CSVs with no idea which period or basis they cover — and, critically,
 * no indication that a section failed.
 */
export function buildReadme(args: {
  financialYear: string;
  generatedAt: string;
  from?: unknown;
  to?: unknown;
  files: string[];
  errors: [string, string][];
}): string {
  return [
    `# Financial Year ${args.financialYear} - handover pack`,
    "",
    `Generated: ${args.generatedAt}`,
    `Period: ${args.from} to ${args.to}`,
    "",
    "## Contents",
    "",
    ...args.files.map((f) => `- \`${f}\``),
    "",
    "## Notes",
    "",
    "- Annual GST figures are the sum of the twelve monthly returns.",
    "- GSTR-3B has no separate annual return; this is the 12-month summary.",
    "- Inventory (1200) uses a weighted-average cost basis.",
    ...(args.errors.length
      ? [
          "",
          "## Sections that could not be generated",
          "",
          ...args.errors.map(([k, v]) => `- **${k}** - ${v}`),
          "",
          "Everything else in this pack is complete.",
        ]
      : ["", "All sections generated successfully."]),
    "",
  ].join("\n");
}