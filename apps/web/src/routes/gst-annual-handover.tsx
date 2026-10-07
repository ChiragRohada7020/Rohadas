/**
 * One-click year-end CA handover.
 *
 * Two steps on purpose: "Prepare" fetches the reports (they take a moment, since
 * the annual GST figures loop twelve months), then "Download" zips them. Doing
 * it in one click would leave the user staring at an unexplained pause.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/hooks/useToast";
import { LoadError } from "./gst-annual-shared";
import { rec } from "./gst-annual-csv";
import { buildHandoverZip } from "./gst-annual-zip";

export function CAHandoverView({ financialYear }: { financialYear: number }) {
  const [building, setBuilding] = useState(false);
  const { data, isLoading, error, refetch } = trpc.caHandover.pack.useQuery(
    { financialYear },
    { enabled: false, staleTime: 0 },
  );

  async function handleDownload() {
    setBuilding(true);
    try {
      const out = await buildHandoverZip({
        financialYear: data!.financialYear,
        generatedAt: data!.generatedAt,
        period: data!.period,
        sections: data!.sections,
        errors: data!.errors,
      });
      const url = URL.createObjectURL(out.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `CA_Handover_FY${out.financialYear}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`CA handover pack downloaded (${out.count} files)`);
    } catch (e) {
      toast.error(`Could not build the pack: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBuilding(false);
    }
  }

  const errCount = data ? Object.keys(rec(data.errors)).length : 0;

  return (
    <div className="space-y-5">
      <div className="card px-5 py-5">
        <h3 className="text-sm font-semibold text-text-primary mb-1">CA Handover Pack</h3>
        <p className="text-xs text-text-tertiary mb-4">
          One ZIP with everything a chartered accountant asks for at year end: the
          annual GST returns, the ITC statement, the books, and the financial
          statements — plus a README explaining each file.
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            className="btn-primary"
            onClick={() => void refetch()}
            disabled={isLoading || building}
          >
            {isLoading ? "Preparing…" : data ? "Refresh pack" : "Prepare pack"}
          </button>
          {data && (
            <button
              className="btn-secondary"
              onClick={() => void handleDownload()}
              disabled={building}
            >
              {building ? "Zipping…" : "Download ZIP"}
            </button>
          )}
        </div>
        {data && (
          <p className="text-xs text-text-tertiary mt-3">
            FY {data.financialYear} ·{" "}
            {errCount > 0
              ? `${errCount} section(s) unavailable — listed in the README`
              : "all sections ready"}
          </p>
        )}
      </div>
      <LoadError error={error} />
    </div>
  );
}