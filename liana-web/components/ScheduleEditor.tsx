"use client";

import { useMemo, useState } from "react";

// The schedule editor: dropdowns that read as a sentence — "Every day at 8:00 AM in <tz>" —
// composing to cron underneath. Covers the shapes people actually schedule (daily, weekdays,
// chosen days, monthly day-N, every N hours, on demand); anything else round-trips through the
// Advanced cron field, so no expressible schedule is lost. Cron itself never appears unless you
// open Advanced.

type Freq = "daily" | "weekdays" | "weekly" | "monthly" | "hourly" | "manual" | "custom";

interface ScheduleState {
  freq: Freq;
  hour12: number; // 1-12
  minute: number; // 0-55 step 5
  ampm: "AM" | "PM";
  days: number[]; // 0=Sun..6=Sat, for freq=weekly
  dayOfMonth: number; // 1-28, for freq=monthly
  everyHours: number; // for freq=hourly
  customCron: string; // for freq=custom
  timezone: string;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_CHOICES = [1, 2, 3, 4, 6, 8, 12];

function to24h(hour12: number, ampm: "AM" | "PM"): number {
  return ampm === "AM" ? hour12 % 12 : (hour12 % 12) + 12;
}
function from24h(h: number): { hour12: number; ampm: "AM" | "PM" } {
  return { hour12: h % 12 === 0 ? 12 : h % 12, ampm: h < 12 ? "AM" : "PM" };
}

// State -> cron (null = on demand). Weekly with no days selected composes nothing (caller guards).
function toCron(s: ScheduleState): string | null {
  const m = s.minute;
  const h = to24h(s.hour12, s.ampm);
  switch (s.freq) {
    case "manual":
      return null;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${[...s.days].sort((a, b) => a - b).join(",")}`;
    case "monthly":
      return `${m} ${h} ${s.dayOfMonth} * *`;
    case "hourly":
      return s.everyHours === 1 ? `${m} * * * *` : `${m} */${s.everyHours} * * *`;
    case "custom":
      return s.customCron.trim() || null;
  }
}

// Cron -> state. Recognizes exactly the shapes toCron produces; anything else lands in Advanced
// with the raw expression preserved.
function parseCron(cron: string | null, timezone: string): ScheduleState {
  const base: ScheduleState = {
    freq: "manual",
    hour12: 8,
    minute: 0,
    ampm: "AM",
    days: [1],
    dayOfMonth: 1,
    everyHours: 6,
    customCron: "",
    timezone,
  };
  if (!cron) return base;
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts;
    const m = Number(min);
    const validMin = /^\d{1,2}$/.test(min) && m >= 0 && m <= 59;
    if (validMin && /^\d{1,2}$/.test(hour) && mon === "*") {
      const h = Number(hour);
      if (h >= 0 && h <= 23) {
        const time = { minute: m, ...from24h(h) };
        if (dom === "*" && dow === "*") return { ...base, ...time, freq: "daily" };
        if (dom === "*" && dow === "1-5") return { ...base, ...time, freq: "weekdays" };
        if (dom === "*" && /^[0-6](,[0-6])*$/.test(dow)) {
          return { ...base, ...time, freq: "weekly", days: dow.split(",").map(Number) };
        }
        if (dow === "*" && /^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
          return { ...base, ...time, freq: "monthly", dayOfMonth: Number(dom) };
        }
      }
    }
    if (validMin && dom === "*" && mon === "*" && dow === "*") {
      if (hour === "*") return { ...base, minute: m, freq: "hourly", everyHours: 1 };
      const step = /^\*\/(\d{1,2})$/.exec(hour);
      if (step) return { ...base, minute: m, freq: "hourly", everyHours: Number(step[1]) };
    }
  }
  return { ...base, freq: "custom", customCron: cron };
}

const TIMEZONES: string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["America/Los_Angeles", "America/New_York", "UTC"];

export default function ScheduleEditor(props: {
  cron: string | null;
  timezone: string | null;
  onSave: (cron: string | null, timezone?: string) => void;
}) {
  const initialTz = props.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const initial = useMemo(() => parseCron(props.cron, initialTz), [props.cron, initialTz]);
  const [s, setS] = useState<ScheduleState>(initial);

  const set = (patch: Partial<ScheduleState>) => setS((prev) => ({ ...prev, ...patch }));

  const composed = toCron(s);
  const incomplete = s.freq === "weekly" && s.days.length === 0;
  const dirty = composed !== props.cron || (composed !== null && s.timezone !== (props.timezone ?? initialTz));
  const showsTime = s.freq === "daily" || s.freq === "weekdays" || s.freq === "weekly" || s.freq === "monthly";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select value={s.freq} onChange={(e) => set({ freq: e.target.value as Freq })}>
          <option value="daily">Every day</option>
          <option value="weekdays">Weekdays</option>
          <option value="weekly">Specific days</option>
          <option value="monthly">Monthly</option>
          <option value="hourly">Every few hours</option>
          <option value="manual">On demand only</option>
          <option value="custom">Advanced (cron)</option>
        </select>

        {s.freq === "weekly" && (
          <span style={{ display: "flex", gap: 4 }}>
            {DAY_LABELS.map((label, d) => (
              <button
                key={d}
                type="button"
                className="btn"
                style={{
                  padding: "4px 8px",
                  fontSize: 12.5,
                  ...(s.days.includes(d)
                    ? { background: "var(--leaf)", borderColor: "var(--leaf)", color: "#fff" }
                    : {}),
                }}
                onClick={() =>
                  set({ days: s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d] })
                }
              >
                {label}
              </button>
            ))}
          </span>
        )}

        {s.freq === "monthly" && (
          <>
            <span className="muted">on day</span>
            <select value={s.dayOfMonth} onChange={(e) => set({ dayOfMonth: Number(e.target.value) })}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </>
        )}

        {s.freq === "hourly" && (
          <>
            <span className="muted">every</span>
            <select value={s.everyHours} onChange={(e) => set({ everyHours: Number(e.target.value) })}>
              {HOUR_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "hour" : `${n} hours`}
                </option>
              ))}
            </select>
          </>
        )}

        {showsTime && (
          <>
            <span className="muted">at</span>
            <select value={s.hour12} onChange={(e) => set({ hour12: Number(e.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
            <select value={s.minute} onChange={(e) => set({ minute: Number(e.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                <option key={m} value={m}>
                  :{String(m).padStart(2, "0")}
                </option>
              ))}
            </select>
            <select value={s.ampm} onChange={(e) => set({ ampm: e.target.value as "AM" | "PM" })}>
              <option>AM</option>
              <option>PM</option>
            </select>
          </>
        )}

        {s.freq === "custom" && (
          <input
            value={s.customCron}
            placeholder="0 8 * * 1-5"
            size={16}
            style={{ fontFamily: "monospace" }}
            onChange={(e) => set({ customCron: e.target.value })}
          />
        )}

        {composed !== null && s.freq !== "custom" && (
          <>
            <span className="muted">in</span>
            <select value={s.timezone} onChange={(e) => set({ timezone: e.target.value })} style={{ maxWidth: 180 }}>
              {!TIMEZONES.includes(s.timezone) && <option value={s.timezone}>{s.timezone}</option>}
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </>
        )}
      </span>

      {dirty && !incomplete && (
        <span>
          <button className="btn primary" onClick={() => props.onSave(composed, composed ? s.timezone : undefined)}>
            Save schedule
          </button>
        </span>
      )}
      {incomplete && <span className="muted" style={{ fontSize: 13 }}>Pick at least one day.</span>}
    </div>
  );
}
