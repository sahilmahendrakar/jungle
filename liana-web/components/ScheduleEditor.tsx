"use client";

import { useMemo, useState } from "react";

// The schedule editor: dropdowns that read as a sentence — "Every day at 8:00 AM in <tz>" or
// "Once on <date> at <time> in <tz>" — composing to a cron, a one-time runAt, or on-demand
// underneath. Covers the shapes people actually schedule (daily, weekdays, chosen days, monthly
// day-N, every N hours, a single future time, on demand); any cron it can't round-trip lands in
// the Advanced field, so no expressible schedule is lost. Cron itself never appears unless you
// open Advanced.

type Freq = "daily" | "weekdays" | "weekly" | "monthly" | "hourly" | "once" | "manual" | "custom";

// What the editor emits on save. The parent maps it to a PATCH: cron+timezone (recurring),
// runAt+timezone (one-time; runAt is a LOCAL "YYYY-MM-DDTHH:MM" the server resolves in the tz),
// or cron:null (on demand).
export type ScheduleValue =
  | { kind: "cron"; cron: string; timezone: string }
  | { kind: "once"; runAt: string; timezone: string }
  | { kind: "manual" };

interface ScheduleState {
  freq: Freq;
  hour12: number; // 1-12
  minute: number; // 0-55 step 5
  ampm: "AM" | "PM";
  days: number[]; // 0=Sun..6=Sat, for freq=weekly
  dayOfMonth: number; // 1-28, for freq=monthly
  everyHours: number; // for freq=hourly
  onceLocal: string; // "YYYY-MM-DDTHH:MM", for freq=once
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
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// An absolute ISO instant -> the "YYYY-MM-DDTHH:MM" wall-clock it reads as in `tz`, for the
// datetime-local input. Mirrors the server's tz handling so the value round-trips unchanged.
function isoToLocalInput(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return defaultOnceLocal();
  try {
    const p: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(d)) {
      p[part.type] = part.value;
    }
    const hour = p.hour === "24" ? "00" : p.hour;
    return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}`;
  } catch {
    return defaultOnceLocal();
  }
}

// Default one-time target when there's nothing to seed from: tomorrow at 9:00 (browser-local).
function defaultOnceLocal(): string {
  const d = new Date(Date.now() + 24 * 3600_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
}

// State -> the value to save. Weekly with no days selected composes nothing (caller guards).
function toValue(s: ScheduleState): ScheduleValue {
  const m = s.minute;
  const h = to24h(s.hour12, s.ampm);
  switch (s.freq) {
    case "manual":
      return { kind: "manual" };
    case "once":
      return { kind: "once", runAt: s.onceLocal, timezone: s.timezone };
    case "daily":
      return { kind: "cron", cron: `${m} ${h} * * *`, timezone: s.timezone };
    case "weekdays":
      return { kind: "cron", cron: `${m} ${h} * * 1-5`, timezone: s.timezone };
    case "weekly":
      return { kind: "cron", cron: `${m} ${h} * * ${[...s.days].sort((a, b) => a - b).join(",")}`, timezone: s.timezone };
    case "monthly":
      return { kind: "cron", cron: `${m} ${h} ${s.dayOfMonth} * *`, timezone: s.timezone };
    case "hourly":
      return { kind: "cron", cron: s.everyHours === 1 ? `${m} * * * *` : `${m} */${s.everyHours} * * *`, timezone: s.timezone };
    case "custom":
      return s.customCron.trim() ? { kind: "cron", cron: s.customCron.trim(), timezone: s.timezone } : { kind: "manual" };
  }
}

// Cron -> state. Recognizes exactly the shapes toValue produces; anything else lands in Advanced
// with the raw expression preserved.
function parseCron(cron: string, base: ScheduleState): ScheduleState {
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

function initialState(
  trigger: { type: string; cron?: string; runAt?: string; timezone?: string },
  fallbackTz: string,
): ScheduleState {
  const tz = trigger.timezone || fallbackTz;
  const base: ScheduleState = {
    freq: "manual",
    hour12: 8,
    minute: 0,
    ampm: "AM",
    days: [1],
    dayOfMonth: 1,
    everyHours: 6,
    onceLocal: defaultOnceLocal(),
    customCron: "",
    timezone: tz,
  };
  if (trigger.type === "schedule" && trigger.cron) return parseCron(trigger.cron, base);
  if (trigger.type === "once" && trigger.runAt) return { ...base, freq: "once", onceLocal: isoToLocalInput(trigger.runAt, tz) };
  return base;
}

const TIMEZONES: string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["America/Los_Angeles", "America/New_York", "UTC"];

function sameAsSaved(v: ScheduleValue, trigger: { type: string; cron?: string; runAt?: string; timezone?: string }): boolean {
  if (v.kind === "manual") return trigger.type !== "schedule" && trigger.type !== "once";
  if (v.kind === "cron") return trigger.type === "schedule" && trigger.cron === v.cron && trigger.timezone === v.timezone;
  // 'once': the stored runAt is absolute while our value is a local wall-clock — treat any once
  // edit as dirty (cheap; an exact compare would need a full tz resolve).
  return false;
}

export default function ScheduleEditor(props: {
  trigger: { type: string; cron?: string; runAt?: string; timezone?: string };
  onSave: (value: ScheduleValue) => void;
}) {
  const fallbackTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const initial = useMemo(() => initialState(props.trigger, fallbackTz), [props.trigger, fallbackTz]);
  const [s, setS] = useState<ScheduleState>(initial);

  const set = (patch: Partial<ScheduleState>) => setS((prev) => ({ ...prev, ...patch }));

  const value = toValue(s);
  const incompleteDays = s.freq === "weekly" && s.days.length === 0;
  const oncePast = s.freq === "once" && new Date(s.onceLocal).getTime() <= Date.now();
  const dirty = !sameAsSaved(value, props.trigger);
  const showsTime = s.freq === "daily" || s.freq === "weekdays" || s.freq === "weekly" || s.freq === "monthly";
  const showsTz = value.kind !== "manual" && s.freq !== "custom";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select value={s.freq} onChange={(e) => set({ freq: e.target.value as Freq })}>
          <option value="daily">Every day</option>
          <option value="weekdays">Weekdays</option>
          <option value="weekly">Specific days</option>
          <option value="monthly">Monthly</option>
          <option value="hourly">Every few hours</option>
          <option value="once">Just once</option>
          <option value="manual">On demand only</option>
          <option value="custom">Advanced (cron)</option>
        </select>

        {s.freq === "once" && (
          <>
            <span className="muted">on</span>
            <input
              type="datetime-local"
              value={s.onceLocal}
              onChange={(e) => set({ onceLocal: e.target.value })}
            />
          </>
        )}

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

        {showsTz && (
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

      {dirty && !incompleteDays && !oncePast && (
        <span>
          <button className="btn primary" onClick={() => props.onSave(value)}>
            Save schedule
          </button>
        </span>
      )}
      {incompleteDays && <span className="muted" style={{ fontSize: 13 }}>Pick at least one day.</span>}
      {oncePast && <span className="muted" style={{ fontSize: 13 }}>Pick a time in the future.</span>}
    </div>
  );
}
