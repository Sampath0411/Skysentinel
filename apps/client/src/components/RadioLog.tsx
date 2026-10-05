import { useEffect, useMemo, useRef } from "react";
import type { AnySimEvent } from "@skysentinel/shared";
import { describeEvent, eventClass, fmtClock } from "../format.js";

const FILTERS = ["all", "decisions", "reports", "authority", "sensors"] as const;
type Filter = (typeof FILTERS)[number];

const matchFilter = (ev: AnySimEvent, filter: Filter): boolean => {
  if (filter === "all") return true;
  const cls = eventClass(ev.type);
  if (filter === "decisions") return cls === "decision";
  if (filter === "reports") return cls === "report";
  if (filter === "authority") return cls === "authority" || cls === "critical";
  if (filter === "sensors") return cls === "sensor";
  return true;
};

/** Radio log — the trainee's event stream, colour-coded (PRD §13.1). */
export default function RadioLog({ events }: { events: readonly AnySimEvent[] }) {
  const [filter, setFilter] = useStateFilter();
  const scrollRef = useRef<HTMLDivElement>(null);

  const lines = useMemo(
    () => events.filter((e) => matchFilter(e, filter)).slice(-120),
    [events, filter],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div>
      <h3>Radio log</h3>
      <div className="tabs">
        {FILTERS.map((f) => (
          <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>
      <div className="radio-log" ref={scrollRef}>
        {lines.map((ev) => (
          <div className="line" key={ev.seq}>
            <span className="t">{fmtClock(ev.t_ms)}</span>
            <span className={eventClass(ev.type)}>{describeEvent(ev)}</span>
          </div>
        ))}
        {lines.length === 0 && <div className="line dim">No events yet.</div>}
      </div>
    </div>
  );
}

// Tiny local hook so this file stays self-contained.
import { useState } from "react";
const useStateFilter = () => useState<Filter>("all");
