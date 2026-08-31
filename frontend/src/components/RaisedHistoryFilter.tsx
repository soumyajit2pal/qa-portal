import { useState } from "react";

export type RaisedHistoryRange = { from: string; to: string };

type Preset = "all" | "7d" | "30d" | "3m" | "6m" | "custom";

function istDateInput(date: Date): string {
  const fields = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (name: string) => fields.find((field) => field.type === name)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateRange(preset: Exclude<Preset, "all" | "custom">): RaisedHistoryRange {
  const end = new Date();
  const start = new Date(end);
  if (preset === "7d") start.setDate(start.getDate() - 6);
  if (preset === "30d") start.setDate(start.getDate() - 29);
  if (preset === "3m") start.setMonth(start.getMonth() - 3);
  if (preset === "6m") start.setMonth(start.getMonth() - 6);
  return { from: istDateInput(start), to: istDateInput(end) };
}

/**
 * Shared request-list control. Its range is intentionally sent only as
 * `raised_from` / `raised_to`: the backend keeps every active or pending row
 * visible, and narrows only terminal (closed/history) rows in SQL.
 */
export default function RaisedHistoryFilter({
  value,
  onChange,
}: {
  value: RaisedHistoryRange;
  onChange: (next: RaisedHistoryRange) => void;
}) {
  const [preset, setPreset] = useState<Preset>("all");

  function changePreset(next: Preset) {
    setPreset(next);
    if (next === "all") onChange({ from: "", to: "" });
    else if (next !== "custom") onChange(dateRange(next));
  }

  return (
    <div className="raised-history-filter">
      <label>
        Historical completed requests
        <select aria-label="Historical completed requests raised-date range" value={preset} onChange={(event) => changePreset(event.target.value as Preset)}>
          <option value="all">All history</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="3m">Last 3 months</option>
          <option value="6m">Last 6 months</option>
          <option value="custom">Custom range</option>
        </select>
      </label>
      {preset === "custom" && (
        <div className="raised-history-custom-range">
          <label>From <input type="date" value={value.from} onChange={(event) => onChange({ ...value, from: event.target.value })} /></label>
          <label>To <input type="date" value={value.to} onChange={(event) => onChange({ ...value, to: event.target.value })} /></label>
        </div>
      )}
      <span className="raised-history-filter-note">Filters closed, cancelled, and rejected requests by raised date. Active work stays visible.</span>
    </div>
  );
}
