import { useState, useCallback } from "react";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { toISOString, toISOStringEndOfDay } from "@/lib/utils";

dayjs.extend(utc);

export type DatePreset =
  | "today"
  | "yesterday"
  | "this-month"
  | "last-month"
  | "last-30"
  | "this-fy"
  | "last-fy"
  | "custom"
  | "all";

/**
 * Build UTC ISO strings for date boundaries.
 *
 * TWO RULES THAT MUST HOLD TOGETHER (violating either shipped the
 * "dashboard shows nothing for Today" bug):
 *
 * 1. WHICH day/month/FY is selected comes from the user's WALL-CLOCK calendar
 *    date (`dayjs()` — local). At 02:00 IST on 10 June, "Today" means
 *    10 June, not the UTC date 9 June.
 *
 * 2. WHERE the boundary instant sits is always UTC MIDNIGHT of that calendar
 *    date (`Date.UTC(...)`), because date-only business fields are stored at
 *    UTC midnight (see toISOString in lib/utils.ts). Never local midnight: in
 *    IST that is "18:30Z the previous day" — outside the window of the very
 *    day it belongs to, which is why Today/This Month showed nothing.
 *
 * In UTC-running CI both rules produce byte-identical strings to the previous
 * `dayjs.utc()` implementation, so the regression tests below (which assert
 * `...T00:00:00.000Z` boundaries) still hold.
 *
 * Public contract: the {fromDate, toDate} strings this returns are always
 * UTC ISO-8601, or empty strings for the "all" preset.
 */

// UTC-midnight instant for a wall-clock (year, month, day). Date.UTC rolls
// over out-of-range days/months correctly (e.g. day 0 → last day of the
// previous month), which the yesterday/last-month cases rely on.
function utcMidnight(year: number, month: number, day: number): dayjs.Dayjs {
  return dayjs.utc(new Date(Date.UTC(year, month, day)));
}

export function getDatePreset(preset: string): { fromDate: string; toDate: string } {
  // Rule 1: wall-clock "now" decides which calendar date the user means.
  const now = dayjs();
  const yyyy = now.year();
  const mm = now.month();

  switch (preset) {
    // A day is a closed UTC window over the wall-clock day. `toDate` must
    // reach the last instant of the day or anything dated later is excluded —
    // that is the same end-of-day trap that used to drop March invoices from
    // April reports.
    case "today": {
      const start = utcMidnight(yyyy, mm, now.date());
      return {
        fromDate: start.toISOString(),
        toDate: start.endOf("day").toISOString(),
      };
    }
    case "yesterday": {
      const start = utcMidnight(yyyy, mm, now.date()).subtract(1, "day");
      return {
        fromDate: start.toISOString(),
        toDate: start.endOf("day").toISOString(),
      };
    }
    case "this-month": {
      const start = utcMidnight(yyyy, mm, 1);
      return {
        fromDate: start.toISOString(),
        toDate: start.endOf("month").toISOString(),
      };
    }
    case "last-month": {
      const start = utcMidnight(yyyy, mm, 1).subtract(1, "month");
      return {
        fromDate: start.toISOString(),
        toDate: start.endOf("month").toISOString(),
      };
    }
    case "last-30": {
      // Intentionally instant-based (not day-aligned): callers rely on the
      // window being exactly 30×24h long.
      const d = now.subtract(30, "day");
      return {
        fromDate: d.toISOString(),
        toDate: now.toISOString(),
      };
    }
    case "this-fy": {
      // Indian FY runs April → March. If we're in Jan–Mar, the FY started
      // last calendar year. The month/day come from the wall clock (rule 1).
      const fyYear = mm >= 3 ? yyyy : yyyy - 1;
      return {
        fromDate: utcMidnight(fyYear, 3, 1).toISOString(),
        toDate: now.toISOString(),
      };
    }
    case "last-fy": {
      const lastFyYear = mm >= 3 ? yyyy - 1 : yyyy - 2;
      return {
        fromDate: utcMidnight(lastFyYear, 3, 1).toISOString(),
        toDate: utcMidnight(lastFyYear + 1, 3, 1).subtract(1, "day").endOf("day").toISOString(),
      };
    }
    case "all":
    default:
      return { fromDate: "", toDate: "" };
  }
}

/**
 * Full list, used by pages that want every period option.
 *
 * The dashboard renders a SUBSET (DASHBOARD_PRESETS) via the `presets` prop on
 * DateRangeBar: nine buttons is a wall of text, and a daily/monthly/yearly
 * question does not need "All" and "Last 30 Days" sitting next to it.
 */
export const DATE_PRESETS: Array<{ value: DatePreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this-month", label: "This Month" },
  { value: "last-month", label: "Last Month" },
  { value: "last-30", label: "Last 30 Days" },
  { value: "this-fy", label: "This FY" },
  { value: "last-fy", label: "Last FY" },
  { value: "custom", label: "Custom" },
  { value: "all", label: "All" },
];

/** Daily / monthly / yearly — what the dashboard actually asks about. */
export const DASHBOARD_PRESETS: Array<{ value: DatePreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this-month", label: "This Month" },
  { value: "last-month", label: "Last Month" },
  { value: "this-fy", label: "This Year" },
  { value: "last-fy", label: "Last Year" },
  { value: "custom", label: "Custom" },
];

export function getGranularity(preset: string): "day" | "week" | "month" | "fy" {
  switch (preset) {
    // A single day buckets daily; week-bucketing it would leave one lone point.
    case "today":
    case "yesterday":
      return "day";
    case "this-month":
    case "last-month":
    case "last-30":
      return "week";
    case "this-fy":
    case "last-fy":
    case "this-quarter":
      return "month";
    case "all":
      return "fy";
    default:
      return "month"; // custom ranges default to monthly
  }
}

export function useDateRange(pageKey: string, defaultPreset: DatePreset = "all") {
  const storageKey = `hisaabo-daterange-${pageKey}`;

  const [preset, setPresetState] = useState<DatePreset>(() => {
    if (typeof window === "undefined") return defaultPreset;
    return (localStorage.getItem(storageKey) as DatePreset) || defaultPreset;
  });

  const [dateRange, setDateRange] = useState(() => getDatePreset(preset));
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const setPreset = useCallback(
    (p: DatePreset) => {
      setPresetState(p);
      localStorage.setItem(storageKey, p);
      if (p !== "custom") {
        setDateRange(getDatePreset(p));
      }
    },
    [storageKey]
  );

  const setCustomRange = useCallback((from: string, to: string) => {
    setCustomFrom(from);
    setCustomTo(to);
    setDateRange({
      fromDate: toISOString(from) ?? "",
      toDate: toISOStringEndOfDay(to) ?? "",
    });
  }, []);

  return {
    preset,
    setPreset,
    dateRange,
    customFrom,
    customTo,
    setCustomRange,
    fromDate: dateRange.fromDate || undefined,
    toDate: dateRange.toDate || undefined,
  };
}
