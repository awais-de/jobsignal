import { useEffect, useState } from "react";
import { supabase } from "./supabase";

// Home: when jobs arrive (owner request 2026-10-29). The days postings are published and the hours new jobs
// reach the portal, from the arrival_pattern RPC; the summary says when checking pays off most.

type Scope = "families" | "matches";
type Pattern = { weekday: number[]; hour: number[]; weeks: number; hours_since: string | null };

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FIRST_HOUR = 6, LAST_HOUR = 23;     // the fast lane checks 07:00–22:30; the axis shows a little either side
const pct = (x: number) => `${Math.round(x * 100)}%`;

export default function ArrivalPattern() {
  const [scope, setScope] = useState<Scope>("families");
  const [p, setP] = useState<Pattern | null>(null);
  useEffect(() => {
    let live = true;
    supabase.rpc("arrival_pattern", { p_scope: scope }).then(({ data }) => { if (live && data) setP(data as Pattern); });
    return () => { live = false; };
  }, [scope]);
  if (!p) return null;

  const dayTotal = p.weekday.reduce((a, b) => a + b, 0);
  const hourTotal = p.hour.reduce((a, b) => a + b, 0);
  if (!dayTotal && !hourTotal) return null;
  const busiest = DAYS.map((d, i) => ({ d, n: p.weekday[i] })).sort((a, b) => b.n - a.n).slice(0, 3);
  const by = (h: number) => p.hour.slice(0, h + 1).reduce((a, b) => a + b, 0) / (hourTotal || 1);
  const hours = p.hour.slice(FIRST_HOUR, LAST_HOUR + 1);

  return (
    <section className="card market-card arrival-card">
      <div className="market-head">
        <h3>When jobs arrive</h3>
        <select value={scope} onChange={(e) => setScope(e.target.value as Scope)} aria-label="Which jobs">
          <option value="families">Your job families</option>
          <option value="matches">Your matches</option>
        </select>
      </div>
      <p className="muted small">German time. {scope === "matches" ? "Core jobs that passed your filters." : "Every posting in your job families."}</p>
      <div className="market-grid arrival-grid">
        <div>
          <h4>Days they're published <span className="muted small">last {p.weeks} full week{p.weeks === 1 ? "" : "s"}</span></h4>
          <Bars values={p.weekday} labels={DAYS} every={1} offset={0} unit="of the week's postings" />
          {dayTotal > 0 && (
            <p className="small">Busiest: <strong>{busiest.map((b) => b.d).join(", ")}</strong>{" "}
              <span className="muted">({pct(busiest.reduce((a, b) => a + b.n, 0) / dayTotal)} of the week)</span></p>
          )}
        </div>
        <div>
          <h4>Hours they reach the portal <span className="muted small">
            {p.hours_since ? `since ${new Date(p.hours_since).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}</span></h4>
          <Bars values={hours} labels={hours.map((_, i) => `${String(FIRST_HOUR + i).padStart(2, "0")}:00`)} every={3} offset={1} unit="of a day's new jobs" />
          {hourTotal > 0 && (
            <p className="small">On the portal by 09:00: <strong>{pct(by(8))}</strong> · by 16:00: <strong>{pct(by(15))}</strong>{" "}
              <span className="muted">· overnight jobs show up at 07:00 (no checks 22:30–07:00)</span></p>
          )}
        </div>
      </div>
    </section>
  );
}

/** Vertical bars, one series: the largest is labelled, every bar has a tooltip. */
function Bars({ values, labels, every, offset, unit }: { values: number[]; labels: string[]; every: number; offset: number; unit: string }) {
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const max = Math.max(...values, 1);
  const top = values.indexOf(max);
  const W = 320, H = 120, headroom = 16, gap = 2;
  const bw = (W - gap * (values.length - 1)) / values.length;
  const y = (v: number) => headroom + (H - headroom) * (1 - v / max);   // 0 sits on the axis
  return (
    <svg className="arrival-bars" viewBox={`0 0 ${W} ${H + 16}`} role="img"
         aria-label={labels.map((l, i) => `${l}: ${pct(values[i] / total)}`).join(", ")}>
      <line x1="0" x2={W} y1={H + 0.5} y2={H + 0.5} className="arrival-axis" />
      {values.map((v, i) => {
        const x = i * (bw + gap), top_ = y(v), h = Math.max(0, H - top_);
        const r = Math.min(4, bw / 2, h);
        return (
          <g key={labels[i]} className="arrival-bar">
            <title>{`${labels[i]}: ${pct(v / total)} ${unit} (${v})`}</title>
            <rect x={x} y={0} width={bw} height={H} fill="transparent" />
            {h > 0 && <path d={`M${x},${H} V${top_ + r} Q${x},${top_} ${x + r},${top_} H${x + bw - r} Q${x + bw},${top_} ${x + bw},${top_ + r} V${H} Z`} />}
            {i === top && <text x={x + bw / 2} y={top_ - 4} textAnchor="middle" className="arrival-value">{pct(v / total)}</text>}
            {i % every === offset && <text x={x + bw / 2} y={H + 13} textAnchor="middle" className="arrival-label">{labels[i]}</text>}
          </g>
        );
      })}
    </svg>
  );
}
