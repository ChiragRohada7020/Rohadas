/**
 * Full-year GSTR-3B.
 *
 * GSTR-3B is filed monthly or quarterly — there is no separate "annual
 * GSTR-3B" return. What a CA wants at year end is the twelve months added up,
 * which is what this shows, with the month-wise table underneath so the total
 * ties back to the filings.
 */

import { trpc } from "@/lib/trpc";
import { StatCard } from "@/components/ui/StatCard";
import { AnnualTable, LoadError, ReportSkeleton, fmt } from "./gst-annual-shared";

const R = "text-right tabular-nums";

export function AnnualGSTR3BView({ financialYear }: { financialYear: number }) {
  const { data, isLoading, error } = trpc.gst.gstr3bAnnual.useQuery({ financialYear });

  if (isLoading) return <ReportSkeleton />;
  if (error) return <LoadError error={error} />;
  if (!data) return null;

  const out = data.outwardSupplies.taxable;
  const zero = data.outwardSupplies.zeroRated;
  const ex = data.outwardSupplies.exempt;

  return (
    <div className="space-y-5">
      <div className="card px-4 py-3">
        <p className="text-sm font-semibold text-text-primary">
          GSTR-3B — Full Year {data.financialYear}
        </p>
        <p className="text-xs text-text-tertiary mt-0.5">
          Twelve months added up. GSTR-3B itself is filed monthly or quarterly —
          this is the year-end summary.
        </p>
      </div>

      <AnnualTable
        title="3.1 — Outward supplies"
        head={
          <tr>
            <th>Nature of supply</th>
            <th className={R}>Taxable Value</th>
            <th className={R}>IGST</th>
            <th className={R}>CGST</th>
            <th className={R}>SGST</th>
          </tr>
        }
        rows={[
          <tr key="t">
            <td className="font-medium">Taxable supplies</td>
            <td className={R}>{fmt(out.taxableValue)}</td>
            <td className={R}>{fmt(out.igst)}</td>
            <td className={R}>{fmt(out.cgst)}</td>
            <td className={R}>{fmt(out.sgst)}</td>
          </tr>,
          <tr key="z">
            <td className="font-medium">Zero rated</td>
            <td className={R}>{fmt(zero.taxableValue)}</td>
            <td className={R}>{fmt(zero.igst)}</td>
            <td className={R}>—</td>
            <td className={R}>—</td>
          </tr>,
          <tr key="e">
            <td className="font-medium">Exempt</td>
            <td className={R}>{fmt(ex.taxableValue)}</td>
            <td className={R}>—</td>
            <td className={R}>—</td>
            <td className={R}>—</td>
          </tr>,
        ]}
        colSpan={5}
        emptyText="No outward supplies this year"
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Eligible ITC (Table 4)" value={fmt(data.itc.total)} />
        <StatCard label="Tax payable — IGST" value={fmt(data.taxPayable.igst)} />
        <StatCard label="Tax payable — CGST" value={fmt(data.taxPayable.cgst)} />
        <StatCard label="Tax payable — SGST" value={fmt(data.taxPayable.sgst)} />
      </div>

      <div className="card px-4 py-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium text-text-primary">
            Net tax payable after ITC
          </span>
          <span
            className={`text-lg font-bold tabular-nums ${
              data.netTax.total >= 0 ? "text-red-600" : "text-emerald-600"
            }`}
          >
            {fmt(data.netTax.total)}
          </span>
        </div>
        <p className="text-xs text-text-tertiary mt-1">
          Negative means excess input credit carried forward.
        </p>
      </div>

      <AnnualTable
        title="Month-wise summary"
        head={
          <tr>
            <th>Month</th>
            <th className={R}>Outward Taxable</th>
            <th className={R}>IGST</th>
            <th className={R}>CGST</th>
            <th className={R}>SGST</th>
            <th className={R}>ITC</th>
          </tr>
        }
        rows={data.monthlyBreakdown.map((r) => (
          <tr key={r.period}>
            <td>{r.period}</td>
            <td className={R}>{fmt(r.outwardTaxable)}</td>
            <td className={R}>{fmt(r.igst)}</td>
            <td className={R}>{fmt(r.cgst)}</td>
            <td className={R}>{fmt(r.sgst)}</td>
            <td className={R}>{fmt(r.itcTotal)}</td>
          </tr>
        ))}
        colSpan={6}
        emptyText="No data for this financial year"
      />
    </div>
  );
}