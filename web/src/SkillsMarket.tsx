import { useEffect, useMemo, useState } from "react";
import { movers, TREND_WEEKS, useMarket, type Market, type MarketSkill } from "./market";
import { keyOf, type Skill } from "./skillmath";
import { useSkills } from "./skills-data";
import { supabase } from "./supabase";

// Home: the skills market at a glance (owner request 2026-10-23). What companies in your job families ask
// for, how that moves week to week (job boards only, once there are enough weeks), and where you stand.

const pct = (x: number) => `${Math.round(x * 100)}%`;
const TOP = 10;
const GAP_RATING = 5;     // rated this or lower: shown as a gap

export default function SkillsMarket() {
  const sk = useSkills(false);
  const [families, setFamilies] = useState<{ key: string; label: string }[]>([]);
  const [family, setFamily] = useState<string | null | undefined>(undefined);   // undefined = not chosen yet
  useEffect(() => {
    supabase.from("owner_profile").select("profile").eq("id", 1).maybeSingle().then(({ data }) => {
      const fs = ((data?.profile as { families?: { key: string; label: string }[] } | undefined)?.families ?? []);
      setFamilies(fs);
      setFamily((f) => (f === undefined ? (fs.find((x) => x.key === "core_data")?.key ?? null) : f));
    });
  }, []);
  const chosen = family === undefined ? null : family;
  const market = useMarket(chosen, "all");
  const boards = useMarket(chosen, "stable");

  const skillFor = useMemo(() => {
    const byId = new Map((sk.catalog ?? []).map((s) => [s.id, s]));
    const byKey = new Map<string, Skill>();
    for (const s of sk.catalog ?? []) for (const k of [s.name_key, keyOf(s.name), ...s.aliases.map(keyOf)]) byKey.set(k, s);
    return (m: MarketSkill) => (m.skillId && byId.get(m.skillId)) || byKey.get(keyOf(m.skill)) || null;
  }, [sk.catalog]);

  if (!market || market.weeks.length === 0) return null;
  const top = [...market.bySkill.values()].filter((m) => !m.generic).sort((a, b) => b.share - a.share).slice(0, TOP);
  const max = Math.max(...top.map((m) => m.share), 0.01);
  const gaps = [...market.bySkill.values()].filter((m) => !m.generic && m.share >= 0.08)
    .map((m) => ({ m, s: skillFor(m) })).filter(({ s }) => !s || (sk.ratingOf(s.id) ?? -1) <= GAP_RATING)
    .sort((a, b) => b.m.share - a.m.share).slice(0, 4);

  return (
    <section className="card market-card">
      <div className="market-head">
        <h3>Skills market</h3>
        <select value={chosen ?? ""} onChange={(e) => setFamily(e.target.value || null)} aria-label="Job family">
          <option value="">All your job families</option>
          {families.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <a className="small" href="#skills">All skills →</a>
      </div>
      <p className="muted small">
        Share of companies whose postings ask for each skill: last {market.recentWeeks} week{market.recentWeeks === 1 ? "" : "s"},
        up to {market.companies} companies a week, every posting seen (not only your feed). Broad terms (AI, cloud, APIs) left out.
      </p>
      <div className="market-grid">
        <div>
          <h4>Most asked for</h4>
          <ul className="market-bars">
            {top.map((m) => {
              const s = skillFor(m), r = s ? sk.ratingOf(s.id) : null;
              const you = !s ? "not in your skills" : r == null ? "not rated" : `you ${r}/10`;
              const gap = !s || r == null || r <= GAP_RATING;
              return (
                <li key={m.skill} title={`${m.skill}: ${pct(m.share)} of companies · ${you}`}>
                  <span className="market-name">{m.skill}</span>
                  <span className="market-bar"><span style={{ width: `${(m.share / max) * 100}%` }} /></span>
                  <span className="market-pct">{pct(m.share)}</span>
                  <span className={`market-you${gap ? " gap" : ""}`}>{gap ? `gap · ${you}` : you}</span>
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <h4>Rising and falling <span className="muted small">job boards only</span></h4>
          <Movers m={boards} />
          {gaps.length > 0 && (
            <>
              <h4>To act on</h4>
              <ul className="market-act">
                {gaps.map(({ m, s }) => (
                  <li key={m.skill}><strong>{m.skill}</strong> <span className="muted small">{pct(m.share)} of companies</span> ·{" "}
                    <a href="#skills">{!s ? "add to your skills" : "rate it"}</a></li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function Movers({ m }: { m: Market | null }) {
  if (!m) return <p className="muted small">Loading…</p>;
  if (m.weeks.length < TREND_WEEKS) {
    const first = m.weeks[0] ? new Date(m.weeks[0]) : null;
    const from = first ? new Date(first.getTime() + (TREND_WEEKS - 1) * 7 * 86400000) : null;
    return (
      <p className="muted small">
        Trends need {TREND_WEEKS} weeks of data so that week-to-week noise doesn't look like a change: {m.weeks.length} so far
        {from ? `, the first in the week of ${from.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}.
      </p>
    );
  }
  const list = movers(m).filter((x) => !x.skill.generic).slice(0, 8);
  if (!list.length) return <p className="muted small">No clear change in the last 3 weeks against the 3 before.</p>;
  return (
    <ul className="market-movers">
      {list.map((x) => (
        <li key={x.skill.skill}>
          <span aria-hidden>{x.after > x.before ? "▲" : "▼"}</span>
          <strong>{x.skill.skill}</strong>
          <span className="muted small">{pct(x.before)} → {pct(x.after)} {x.after > x.before ? "up" : "down"}</span>
        </li>
      ))}
    </ul>
  );
}
