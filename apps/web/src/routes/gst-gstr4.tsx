import { useState } from "react";
import type { ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { StatCard } from "@/components/ui/StatCard";
import { toast } from "@/hooks/useToast";

/**
 * GSTR4View — quarterly return for composition-scheme dealers.
 *
 * WHY A SEPARATE FILE: GSTR-4 is only reachable by composition-scheme
 * businesses, so it does not belong in the 2,000-line gst.tsx tab body.
 *
 * The composition model, which drives every figure shown here:
 *   - outward invoices carry 0% GST — the dealer pays a flat rate on TURNOVER;
 *   - the dealer cannot avail ITC, so purchase credit is reported as reversed;
 *   - the liability is therefore settled in cash, never out of credit.
 *
 * Because the rate is NOT a fixed 1% for everyone, the user picks their
 * statutory category rather than the server guessing. Notification 04/2022-CT
 * sets 1% for goods traders / manufacturers of specified goods, 0.5% for
 * non-specified goods, 5% for restaurants and 6% for specified services.
 */

const RATES: Array<{ value: number; label: string; hint: string }> = [
  { value: 1, label: "1%", hint: "Goods traders / specified goods manufacturers" },
  { value: 0.5, label: "0.5%", hint: "Non-specified goods manufacturers" },
  { value: 5, label: "5%", hint: "Restaurants" },
  { value: 6, label: "6%", hint: "Specified service providers" },
];

const QUARTERS = [
  { value: 1, label: "Q1 — Jan to Mar" },
  { value: 2, label: "Q2 — Apr to Jun" },
  { value: 3, label: "Q3 — Jul to Sep" },
  { value: 4, label: "Q4 — Oct to Dec" },
];

/** Format an integer paise value with Indian digit grouping and 2dp. */
function fmt(paise: number): string {
  return (paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

interface Row {
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

function GSTR4Row({ label, desc, row }: { label: string; desc: string; row: Row }) {
  return (
    <tr>
      <td className="px-4 py-2 text-xs text-text-tertiary font-medium">{label}</td>
      <td className="px-4 py-2 text-sm text-text-primary">{desc}</td>
      <td className="px-4 py-2 text-right tabular-nums">{fmt(row.taxableValue)}</td>
      <td className="px-4 py-2 text-right tabular-nums text-text-secondary">{fmt(row.cgst)}</td>
      <td className="px-4 py-2 text-right tabular-nums text-text-secondary">{fmt(row.sgst)}</td>
      <td className="px-4 py-2 text-right tabular-nums text-text-secondary">{fmt(row.igst)}</td>
    </tr>
  );
}

function GSTR4Table({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <div className="card overflow-hidden mb-4">
      <div className="px-4 py-3 border-b border-border-light bg-surface-1">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <p className="text-xs text-text-tertiary mt-0.5">{caption}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-12">Sl.</th>
              <th>Description</th>
              <th className="text-right">Taxable Value</th>
              <th className="text-right">CGST</th>
              <th className="text-right">SGST</th>
              <th className="text-right">IGST</th>
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

export function GSTR4View() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [quarter, setQuarter] = useState(Math.floor(now.getMonth() / 3) + 1);
  const [compositionRate, setCompositionRate] = useState(1);
  const [downloading, setDownloading] = useState(false);

  const { data, isLoading, error } = trpc.gst.gstr4.useQuery({ year, quarter, compositionRate });
  const utils = trpc.useUtils();

  const years = Array.from({ length: 5 }, (_, i) => now.getFullYear() - i);

  async function handleDownloadJson() {
    setDownloading(true);
    try {
      const result = await utils.gst.gstr4Json.fetch({ year, quarter, compositionRate });
      if (!result) return;
      const blob = new Blob([JSON.stringify(result.json, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("GSTR-4 portal JSON downloaded");
    } catch {
      toast.error("Download failed");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Quarter + rate selectors */}
      <div className="card px-4 py-4 flex flex-col sm:flex-row sm:items-end gap-4 flex-wrap">
        <div>
          <p className="text-xs text-text-tertiary mb-1 font-medium uppercase tracking-wide">Year</p>
          <select
            className="input w-28"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            aria-label="Select year"
          >
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div>
          <p className="text-xs text-text-tertiary mb-1 font-medium uppercase tracking-wide">Quarter</p>
          <select
            className="input w-48"
            value={quarter}
            onChange={(e) => setQuarter(Number(e.target.value))}
            aria-label="Select quarter"
          >
            {QUARTERS.map((q) => (
              <option key={q.value} value={q.value}>{q.label}</option>
            ))}
          </select>
        </div>
        <div>
          <p className="text-xs text-text-tertiary mb-1 font-medium uppercase tracking-wide">
            Composition rate
          </p>
          <select
            className="input w-64"
            value={compositionRate}
            onChange={(e) => setCompositionRate(Number(e.target.value))}
            aria-label="Select composition rate"
          >
            {RATES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label} — {r.hint}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={handleDownloadJson}
          disabled={downloading || !data}
          className="btn-secondary inline-flex items-center justify-center gap-2 sm:ml-auto"
        >
          {downloading ? "Preparing…" : "Download portal JSON"}
        </button>
      </div>

      <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 px-4 py-2">
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Composition dealers charge customers 0% GST and pay a flat rate on turnover, and cannot
          claim input tax credit — so tax is settled in cash and purchase credit is reported as
          reversed. Check your rate against Notification 04/2022-CT before filing.
        </p>
      </div>

      {isLoading && (
        <div className="card px-5 py-4">
          <p className="text-sm text-text-tertiary">Loading GSTR-4…</p>
        </div>
      )}

      {error && (
        <div className="card px-5 py-4 border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-800">
          <p className="text-sm text-red-700 dark:text-red-400">Failed to load GSTR-4: {error.message}</p>
        </div>
      )}

      {data && (
        <>
          {/* Business + period header */}
          <div className="card px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2">
            <div>
              <p className="text-sm font-semibold text-text-primary">{data.businessName}</p>
              <p className="text-xs text-text-secondary font-mono">{data.businessGstin || "GSTIN not set"}</p>
            </div>
            <div className="sm:ml-auto text-right">
              <p className="text-sm font-semibold text-text-primary">{data.period}</p>
              <p className="text-xs text-text-tertiary">Return period Q{data.quarter} {data.year}</p>
            </div>
          </div>

          {/* Headline figures */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard
              size="md"
              label="Turnover for the quarter"
              value={`₹${fmt(data.turnover)}`}
              note={`Flat composition rate applied: ${data.compositionRate}%`}
            />
            <StatCard
              size="md"
              label="Tax payable"
              value={`₹${fmt(data.table6.taxPayableOnTurnover)}`}
              note={`${data.compositionRate}% of turnover, payable in cash`}
            />
            <StatCard
              size="md"
              label="ITC reversed (not availed)"
              value={`₹${fmt(data.table5.total.cgst + data.table5.total.sgst + data.table5.total.igst)}`}
              note="Composition dealers cannot claim credit"
            />
          </div>

          {/* Table 4 */}
          <GSTR4Table
            title="Table 4 — Details of advances received and inward supplies"
            caption="Own supplies (4B) are the turnover the flat rate is charged on."
          >
            <GSTR4Row label="4A(i)" desc="Inward supplies from exempt suppliers" row={data.table4.inwardExempt} />
            <GSTR4Row label="4A(ii)" desc="Inward supplies from non-exempt suppliers" row={data.table4.inwardNonExempt} />
            <GSTR4Row label="4B(i)" desc="Own supplies — exempt" row={data.table4.ownExempt} />
            <GSTR4Row label="4B(ii)" desc="Own supplies — taxable (turnover)" row={data.table4.ownNonExempt} />
            <GSTR4Row label="4C" desc="Inward supplies liable to reverse charge" row={data.table4.inwardReverseCharge} />
            <GSTR4Row label="4D" desc="Inward supplies from ISD" row={data.table4.inwardIsd} />
            <GSTR4Row label="4E" desc="All other ITC related information" row={data.table4.otherItc} />
            <GSTR4Row label="4F" desc="Refund" row={data.table4.refund} />
          </GSTR4Table>

          {/* Table 5 */}
          <GSTR4Table
            title="Table 5 — Details of input tax credit reversed"
            caption="A composition dealer avails no credit, so purchase credit is reported here."
          >
            <GSTR4Row label="5A" desc="As per Rules 42 / 42A / 43 / 43A" row={data.table5.rule42_43} />
            <GSTR4Row label="5B" desc="As per Section 17(5)" row={data.table5.section17_5} />
            <GSTR4Row label="5C" desc="Others" row={data.table5.others} />
            <tr className="bg-surface-1 border-t-2 border-border-color font-semibold">
              <td className="px-4 py-2 text-xs text-text-tertiary font-medium">—</td>
              <td className="px-4 py-2 text-sm font-bold text-text-primary">Total ITC reversed</td>
              <td className="px-4 py-2 text-right tabular-nums font-bold">{fmt(data.table5.total.taxableValue)}</td>
              <td className="px-4 py-2 text-right tabular-nums font-bold">{fmt(data.table5.total.cgst)}</td>
              <td className="px-4 py-2 text-right tabular-nums font-bold">{fmt(data.table5.total.sgst)}</td>
              <td className="px-4 py-2 text-right tabular-nums font-bold">{fmt(data.table5.total.igst)}</td>
            </tr>
          </GSTR4Table>

          {/* Table 6 */}
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-border-light bg-surface-1">
              <h3 className="text-sm font-semibold text-text-primary">Table 6 — Details of tax paid</h3>
              <p className="text-xs text-text-tertiary mt-0.5">
                Tax is payable in cash because no ITC is available to offset it.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table">
                <tbody>
                  <tr>
                    <td className="px-4 py-2 text-xs text-text-tertiary font-medium">6.1(a)</td>
                    <td className="px-4 py-2 text-sm text-text-primary">Tax payable on turnover</td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold">
                      ₹{fmt(data.table6.taxPayableOnTurnover)}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 text-xs text-text-tertiary font-medium">6.2(a)</td>
                    <td className="px-4 py-2 text-sm text-text-primary">Tax paid through ITC</td>
                    <td className="px-4 py-2 text-right tabular-nums">₹{fmt(data.table6.taxPaidViaItc)}</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 text-xs text-text-tertiary font-medium">6.2(b)</td>
                    <td className="px-4 py-2 text-sm text-text-primary">Tax paid through cash</td>
                    <td className="px-4 py-2 text-right tabular-nums">₹{fmt(data.table6.taxPaidViaCash)}</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 text-xs text-text-tertiary font-medium">6.3</td>
                    <td className="px-4 py-2 text-sm text-text-primary">Excess ITC utilised</td>
                    <td className="px-4 py-2 text-right tabular-nums">₹{fmt(data.table6.excessItcUtilised)}</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr className="bg-surface-1 border-t-2 border-border-color font-semibold">
                    <td className="px-4 py-2 text-xs text-text-tertiary font-medium">—</td>
                    <td className="px-4 py-2 text-sm font-bold text-text-primary">Total payable for the quarter</td>
                    <td className="px-4 py-2 text-right tabular-nums font-bold">                    ₹{fmt(data.taxPayable)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

