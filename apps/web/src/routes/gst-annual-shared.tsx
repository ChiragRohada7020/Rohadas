/**
 * Shared building blocks for the full-year GST views and the CA handover pack.
 *
 * Split into its own module (rather than living inside gst.tsx) for two reasons:
 * gst.tsx is already ~2,000 lines, and keeping the annual views in single-purpose
 * files means each can be read — and edited — without wading through the monthly
 * screens.
 *
 * Everything here renders real UTF-8. Do NOT round-trip this file through a
 * PowerShell `Get-Content -Raw` / `Set-Content -Encoding UTF8` pair: Windows
 * PowerShell DECODES as Windows-1252 and re-encodes as UTF-8, which silently
 * turned every en dash into "â€" and broke labels across the app. Use the editor
 * tool or Node (`fs.writeFileSync(..., "utf8")`) instead.
 */

import type { ReactElement, ReactNode } from "react";
import { formatCurrency } from "@/lib/utils";

export const fmt = (n: number): string => formatCurrency(n);

/** Placeholder shown while a report loads. */
export function ReportSkeleton() {
  return (
    <div className="card px-5 py-4 space-y-3">
      <div className="skeleton h-4 w-32" />
      <div className="skeleton h-4 w-full" />
      <div className="skeleton h-4 w-3/4" />
    </div>
  );
}

/** Error box. A rate-limit (429) is called out separately because it is
 * transient: the report is not lost, the user just needs to wait a moment. */
export function LoadError({ error }: { error: { message: string } | null }) {
  if (!error) return null;
  const rateLimited =
    /too many requests/i.test(error.message) ||
    /TOO_MANY_REQUESTS/i.test(error.message);
  return (
    <div className="card px-5 py-4 border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800">
      <p className="text-sm text-amber-800 dark:text-amber-300">
        {rateLimited
          ? "This report is rate limited right now — too many requests were made in the last minute. Wait about a minute and refresh; nothing is lost."
          : `Failed to load report: ${error.message}`}
      </p>
    </div>
  );
}

/** Card + table shell shared by the annual tables so they stay consistent. */
export function AnnualTable({
  title,
  head,
  rows,
  colSpan,
  emptyText,
}: {
  title: string;
  head: ReactElement;
  rows: ReactNode[];
  colSpan: number;
  emptyText: string;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-border-light">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>{head}</thead>
          <tbody>
            {rows.length > 0 ? (
              rows
            ) : (
              <tr>
                <td colSpan={colSpan} className="text-center text-text-tertiary py-4">
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}