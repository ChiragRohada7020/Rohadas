// Full-year GSTR-1. Every figure is the API's sum of the twelve monthly returns,
// so a CA can reconcile the year against the filings without re-adding by hand.
import { trpc } from "@/lib/trpc";
import { StatCard } from "@/components/ui/StatCard";
import { toast } from "@/hooks/useToast";
import { AnnualTable, LoadError, ReportSkeleton, fmt } from "./gst-annual-shared";

const R = "text-right tabular-nums";

export function AnnualGSTR1View({ financialYear }: { financialYear: number }) {
  const { data, isLoading, error } = trpc.gst.gstr1Annual.useQuery({ financialYear });
  const { data: csvData } = trpc.gst.gstr1AnnualCsv.useQuery({ financialYear });

  function handleExport() {
    if (!csvData) return;
    const blob = new Blob([csvData.csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvData.filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("GSTR-1 annual CSV exported");
  }

  if (isLoading) return <ReportSkeleton />;
  if (error) return <LoadError error={error} />;
  if (!data) return null;
  const t = data.totals;

  return (
    <div className="space-y-5">
      <div className="card px-4 py-3 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-text-primary">
            GSTR-1 — Full Year {data.financialYear}
          </p>
          <p className="text-xs text-text-tertiary mt-0.5">
            Consolidated April–March. Totals equal the twelve monthly returns summed.
          </p>
        </div>
        <button className="btn-secondary shrink-0" onClick={handleExport} disabled={!csvData}>
          Export CSV
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Invoice Count" value={String(t.invoiceCount)} />
        <StatCard label="Taxable Value" value={fmt(t.taxableValue)} />
        <StatCard label="Total Tax" value={fmt(t.totalTax)} valueColor="text-amber-600" />
        <StatCard label="Total Value" value={fmt(t.totalInvoiceValue)} valueColor="text-emerald-600" />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="CGST" value={fmt(t.cgst)} />
        <StatCard label="SGST" value={fmt(t.sgst)} />
        <StatCard label="IGST" value={fmt(t.igst)} />
      </div>

      <AnnualTable
        title="Month-wise summary"
        head={
          <tr>
            <th>Month</th>
            <th className={R}>Invoices</th>
            <th className={R}>Taxable Value</th>
            <th className={R}>CGST</th>
            <th className={R}>SGST</th>
            <th className={R}>IGST</th>
            <th className={R}>Total Tax</th>
          </tr>
        }
        rows={data.monthlyBreakdown.map((r) => (
          <tr key={r.period} className={r.empty ? "text-text-tertiary" : undefined}>
            <td>{r.period}</td>
            <td className={R}>{r.invoiceCount}</td>
            <td className={R}>{fmt(r.taxableValue)}</td>
            <td className={R}>{fmt(r.cgst)}</td>
            <td className={R}>{fmt(r.sgst)}</td>
            <td className={R}>{fmt(r.igst)}</td>
            <td className={R}>{fmt(r.totalTax)}</td>
          </tr>
        ))}
        colSpan={7}
        emptyText="No data for this financial year"
      />

      <AnnualTable
        title={`B2B — registered customers (${data.b2b.length})`}
        head={
          <tr>
            <th>GSTIN</th>
            <th>Customer</th>
            <th className={R}>Invoices</th>
            <th className={R}>Taxable</th>
            <th className={R}>CGST</th>
            <th className={R}>SGST</th>
            <th className={R}>IGST</th>
          </tr>
        }
        rows={data.b2b.map((r) => (
          <tr key={r.partyGstin}>
            <td className="font-mono text-[13px]">{r.partyGstin}</td>
            <td>{r.partyName}</td>
            <td className={R}>{r.invoiceCount}</td>
            <td className={R}>{fmt(r.taxableValue)}</td>
            <td className={R}>{fmt(r.cgst)}</td>
            <td className={R}>{fmt(r.sgst)}</td>
            <td className={R}>{fmt(r.igst)}</td>
          </tr>
        ))}
        colSpan={7}
        emptyText="No B2B supplies this year"
      />

      <AnnualTable
        title="B2C — rate-wise summary"
        head={
          <tr>
            <th>Rate</th>
            <th className={R}>Taxable</th>
            <th className={R}>CGST</th>
            <th className={R}>SGST</th>
            <th className={R}>IGST</th>
          </tr>
        }
        rows={data.b2cSmall.map((r) => (
          <tr key={r.taxRate}>
            <td>{r.taxRate}%</td>
            <td className={R}>{fmt(r.taxableValue)}</td>
            <td className={R}>{fmt(r.cgst)}</td>
            <td className={R}>{fmt(r.sgst)}</td>
            <td className={R}>{fmt(r.igst)}</td>
          </tr>
        ))}
        colSpan={5}
        emptyText="No B2C supplies this year"
      />

      <AnnualTable
        title={`HSN summary (${data.hsn.length})`}
        head={
          <tr>
            <th>HSN</th>
            <th>Description</th>
            <th className={R}>Qty</th>
            <th className={R}>Taxable</th>
            <th className={R}>CGST</th>
            <th className={R}>SGST</th>
            <th className={R}>IGST</th>
          </tr>
        }
        rows={data.hsn.map((r) => (
          <tr key={r.hsn}>
            <td className="font-mono text-[13px]">{r.hsn}</td>
            <td>{r.description}</td>
            <td className={R}>{r.quantity}</td>
            <td className={R}>{fmt(r.taxableValue)}</td>
            <td className={R}>{fmt(r.cgst)}</td>
            <td className={R}>{fmt(r.sgst)}</td>
            <td className={R}>{fmt(r.igst)}</td>
          </tr>
        ))}
        colSpan={7}
        emptyText="No HSN rows this year"
      />
    </div>
  );
}