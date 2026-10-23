import { useEffect, useMemo, useState } from "react";
import {
  ANCHORS, anchor, demand, keyOf, priority, QUADRANTS, quadrant, suggestParent, TARGET, WEIGHT,
  type Demand, type Filter, type Quadrant, type Skill,
} from "./skillmath";
import { scheduleRerank, useRerankPending, useSkills, type Category } from "./skills-data";
import { supabase } from "./supabase";
import { marketFor, missing, TREND_WEEKS, useMarket, type MarketSkill, type Scope } from "./market";

// Skills database (owner decisions 2026-10-14): how often each skill is asked for, how strong you are in
// it, and what to learn next. Base ratings change only here, by recording an improvement.

type Tab = "gaps" | "ratings" | "new";
const pct = (x: number) => `${Math.round(x * 100)}%`;

export default function Skills() {
  const sk = useSkills(true);
  const [tab, setTab] = useState<Tab>("gaps");
  const [filter, setFilter] = useState<Filter>({ lane: "core", family: null, days: 90 });
  const [families, setFamilies] = useState<{ key: string; label: string }[]>([]);
  const [focus, setFocus] = useState<string | null>(null);          // skill id to rate (from the gaps table)

  useEffect(() => {
    supabase.from("owner_profile").select("profile").eq("id", 1).maybeSingle().then(({ data }) =>
      setFamilies(((data?.profile as { families?: { key: string; label: string }[] } | undefined)?.families ?? [])));
  }, []);

  const d = useMemo(() => (sk.index ? demand(sk.jobs, sk.index, filter, sk.ignored) : null), [sk.index, sk.jobs, filter, sk.ignored]);
  // The "new skills" queue looks at every analysed job of the last year, not only the filtered group.
  const queue = useMemo(() => (sk.index ? demand(sk.jobs, sk.index, { lane: "all", family: null, days: 365 }, sk.ignored).unmatched : []),
    [sk.index, sk.jobs, sk.ignored]);

  if (sk.error) return <p className="notice">{sk.error}</p>;
  if (!sk.catalog || !d) return <p className="empty">Loading…</p>;

  return (
    <div className="skills">
      <div className="responses-bar"><h2>Skills</h2></div>
      <RerankNotice />
      <div className="tabs">
        <button className={tab === "gaps" ? "active" : ""} onClick={() => setTab("gaps")}>Demand &amp; gaps</button>
        <button className={tab === "ratings" ? "active" : ""} onClick={() => setTab("ratings")}>My ratings</button>
        <button className={tab === "new" ? "active" : ""} onClick={() => setTab("new")}>New skills <span className="day-count">{queue.length}</span></button>
      </div>
      {tab === "gaps" && (
        <Gaps d={d} sk={sk} filter={filter} setFilter={setFilter} families={families} ratingOf={sk.ratingOf}
              onRate={(id) => { setFocus(id); setTab("ratings"); }} unmatched={queue.length} toNew={() => setTab("new")} />
      )}
      {tab === "ratings" && <Ratings sk={sk} focus={focus} />}
      {tab === "new" && <NewSkills queue={queue} sk={sk} />}
    </div>
  );
}

function RerankNotice() {
  const pending = useRerankPending();
  return pending ? <p className="notice">Your skills changed: jobs are re-ranked about a minute after your last change.</p> : null;
}

// -- demand & gaps ------------------------------------------------------------------------------
function Gaps({ d, sk, filter, setFilter, families, ratingOf, onRate, unmatched, toNew }: {
  d: ReturnType<typeof demand>; sk: ReturnType<typeof useSkills>; filter: Filter; setFilter: (f: Filter) => void; families: { key: string; label: string }[];
  ratingOf: (id: string) => number | null; onRate: (id: string) => void; unmatched: number; toNew: () => void;
}) {
  const [showIgnore, setShowIgnore] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  const market = useMarket(filter.family, scope);
  const absent = useMemo(() => (market ? missing(market, sk.catalog ?? []) : []), [market, sk.catalog]);
  const groups = useMemo(() => {
    const g: Record<Quadrant, Demand[]> = { learn: [], strength: [], niche: [], ignore: [] };
    for (const r of d.rows) g[quadrant(r.share, ratingOf(r.skill.id))].push(r);
    g.learn.sort((a, b) => priority(b.share, ratingOf(b.skill.id)) - priority(a.share, ratingOf(a.skill.id)));
    return g;
  }, [d, ratingOf]);
  const unratedHigh = d.rows.filter((r) => r.share >= 0.15 && ratingOf(r.skill.id) == null).length;

  return (
    <>
      <div className="filters">
        <select value={filter.lane} onChange={(e) => setFilter({ ...filter, lane: e.target.value as Filter["lane"] })} aria-label="Jobs">
          <option value="core">Core jobs</option><option value="explore">Explore jobs</option><option value="all">All jobs</option>
        </select>
        <select value={filter.family ?? ""} onChange={(e) => setFilter({ ...filter, family: e.target.value || null })} aria-label="Family">
          <option value="">All families</option>
          {families.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <select value={filter.days} onChange={(e) => setFilter({ ...filter, days: Number(e.target.value) })} aria-label="Period">
          <option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option>
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value as Scope)} aria-label="Market sources"
                title="Market figures: every source, or only the job boards whose coverage doesn't grow as career sites are added">
          <option value="all">Market: all sources</option><option value="stable">Market: job boards only</option>
        </select>
        <span className="filter-count">{d.population} analysed jobs</span>
      </div>
      <p className="muted small">
        Demand = share of these jobs asking for a skill (must-have counts {WEIGHT.must}, nice-to-have {WEIGHT.nice}); a variant also
        counts toward its parent. High demand = 15%+. Strong = rated 6+. Priority = demand × distance to {TARGET}/10.
        {unratedHigh > 0 && <> <strong>{unratedHigh} high-demand skill{unratedHigh > 1 ? "s are" : " is"} not rated yet.</strong></>}
        {unmatched > 0 && <> {unmatched} skill names from job ads aren't in the catalogue yet: <button className="link" onClick={toNew}>map them</button> for accurate figures.</>}
      </p>
      {market && (
        <p className="muted small">
          Market = share of companies in {filter.family ? "this family" : "your job families"} whose postings mention the skill
          (every posting seen, not only your feed; last {market.recentWeeks} week{market.recentWeeks === 1 ? "" : "s"}, up to {market.companies} companies a week).
          {market.weeks.length < TREND_WEEKS
            ? <> The weekly trend appears after {TREND_WEEKS} weeks ({market.weeks.length} so far).</>
            : <> The line shows the weekly share.</>}
        </p>
      )}
      {market && absent.length > 0 && (
        <MissingSkills absent={absent} sk={sk} />
      )}
      {d.population < 50 && <p className="notice">Only {d.population} jobs in this group: treat the percentages as rough until more jobs are analysed.</p>}
      {(["learn", "strength", "niche", "ignore"] as Quadrant[]).map((q) => (
        (q !== "ignore" || showIgnore) ? (
          <section key={q} className="card skill-group">
            <h3>{QUADRANTS[q]} <span className="muted small">{groups[q].length}</span></h3>
            {groups[q].length === 0 ? <p className="muted small">None.</p> : (
              <div className="table-wrap"><table className="apps gaps-table">
                <thead><tr><th>Skill</th><th>Demand</th><th>Must-have</th><th title="Share of companies in the market">Market</th><th>Your rating</th><th>Trend</th>{q === "learn" && <th>Priority</th>}</tr></thead>
                <tbody>
                  {groups[q].slice(0, q === "ignore" ? 200 : 60).map((r) => {
                    const rating = ratingOf(r.skill.id);
                    const trend = r.earlier + r.recent < 2 ? "–" : r.recent > r.earlier * 1.3 ? "▲" : r.recent < r.earlier * 0.7 ? "▼" : "→";
                    const m = market ? marketFor(market, r.skill) : undefined;
                    return (
                      <tr key={r.skill.id}>
                        <td className="strong">{r.skill.name}</td>
                        <td><div className="share"><div className="share-fill" style={{ width: pct(Math.min(1, r.share)) }} /><span>{pct(r.share)}</span></div></td>
                        <td>{pct(r.mustShare)}</td>
                        <td><MarketCell m={m} loading={!market} /></td>
                        <td><button className="link" onClick={() => onRate(r.skill.id)}>{rating == null ? "rate" : `${rating}/10`}</button>
                          {rating != null && <span className="muted small"> {anchor(rating)}</span>}</td>
                        <td title="Second half of the period vs the first half">{trend}</td>
                        {q === "learn" && <td>{Math.round(100 * priority(r.share, rating))}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
            )}
          </section>
        ) : null
      ))}
      {!showIgnore && <button className="link" onClick={() => setShowIgnore(true)}>Show “{QUADRANTS.ignore}” ({groups.ignore.length})</button>}
    </>
  );
}

/** Market share, with the weekly line once there are enough weeks. */
function MarketCell({ m, loading }: { m: MarketSkill | undefined; loading: boolean }) {
  if (loading) return <span className="muted">…</span>;
  if (!m) return <span className="muted" title="Not mentioned in the market postings">0%</span>;
  return <span className="market-cell">{pct(m.share)}{m.weekly.length >= TREND_WEEKS && <Sparkline points={m.weekly} />}</span>;
}

function Sparkline({ points }: { points: { week: string; share: number }[] }) {
  const w = 56, h = 16, max = Math.max(...points.map((p) => p.share), 0.01);
  const xy = points.map((p, i) => [2 + (i * (w - 4)) / Math.max(1, points.length - 1), h - 2 - (p.share / max) * (h - 4)]);
  const label = points.map((p) => `${new Date(p.week).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}: ${pct(p.share)}`).join("\n");
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Weekly share: ${label}`}>
      <title>{`Share of companies by week\n${label}`}</title>
      <polyline points={xy.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="2.5" fill="currentColor" />
    </svg>
  );
}

/** Skills the market asks for that aren't in the catalogue (so they can't count in ranking or here yet). */
function MissingSkills({ absent, sk }: { absent: MarketSkill[]; sk: ReturnType<typeof useSkills> }) {
  const [adding, setAdding] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  return (
    <section className="card skill-group">
      <h3>In demand, not in your skills <span className="muted small">{absent.length}</span></h3>
      <p className="muted small">Asked for by 5%+ of companies in the market. Add the ones you have, then rate them: they then count in job ranking.</p>
      <div className="table-wrap"><table className="apps">
        <thead><tr><th>Skill</th><th>Market</th><th></th></tr></thead>
        <tbody>
          {absent.slice(0, all ? 100 : 12).map((m) => (
            <tr key={m.skill}>
              <td className="strong">{m.skill}</td>
              <td><span className="market-cell">{pct(m.share)}{m.weekly.length >= TREND_WEEKS && <Sparkline points={m.weekly} />}</span></td>
              <td>{adding === m.skill
                ? <AddSkill sk={sk} name={m.skill} onDone={() => setAdding(null)} />
                : <button className="link" onClick={() => setAdding(m.skill)}>Add to my skills</button>}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {absent.length > 12 && !all && <button className="link" onClick={() => setAll(true)}>Show all ({absent.length})</button>}
    </section>
  );
}

// -- my ratings (base ratings change only here) ---------------------------------------------------
function Ratings({ sk, focus }: { sk: ReturnType<typeof useSkills>; focus: string | null }) {
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(focus);
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const cats = useMemo(() => {
    const m = new Map<string, Skill[]>();
    for (const s of sk.catalog ?? []) {
      if (q && !`${s.name} ${s.aliases.join(" ")}`.toLowerCase().includes(q.toLowerCase())) continue;
      const c = s.category ?? "other";
      m.set(c, [...(m.get(c) ?? []), s]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [sk.catalog, q]);
  useEffect(() => { if (focus) document.getElementById(`skill-${focus}`)?.scrollIntoView({ block: "center" }); }, [focus]);

  return (
    <>
      <div className="filters">
        <input type="search" placeholder="Find a skill…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="small" onClick={() => setAdding((a) => !a)}>{adding ? "Cancel" : "+ Add a skill"}</button>
      </div>
      <p className="muted small">
        0 {ANCHORS[0]} · 3 {ANCHORS[3]} · 5 {ANCHORS[5]} · 7 {ANCHORS[7]} · 9 {ANCHORS[9]}. A rating changes only when you record an
        improvement (or a correction) here; every change is kept, so you can see your progress. Levels you present for one job are set on that job.
      </p>
      {adding && <AddSkill sk={sk} onDone={() => setAdding(false)} />}
      {cats.map(([cat, list]) => (
        <section key={cat} className="card skill-group">
          <h3>{cat.replace(/_/g, " ")}</h3>
          <CategoryLabels cat={cat} sk={sk} />
          <ul className="rating-list">
            {list.map((s) => {
              const cur = sk.ratings.cur.get(s.id), prev = sk.ratings.prev.get(s.id);
              const parent = s.parent_id ? sk.index?.byId.get(s.parent_id) : null;
              return (
                <li key={s.id} id={`skill-${s.id}`} className={focus === s.id ? "focus" : ""}>
                  <div className="rating-line">
                    <strong>{s.name}</strong>
                    {parent && <span className="muted small">variant of {parent.name}</span>}
                    <span className={`rating-badge${cur ? "" : " none"}`}>{cur ? `${cur.rating}/10` : "not rated"}</span>
                    {cur && <span className="muted small">{anchor(cur.rating)} · {new Date(cur.rated_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                      {prev ? ` · was ${prev.rating}/10` : ""}</span>}
                    <button className="link" onClick={() => setEditing(editing === s.id ? null : s.id)}>
                      {editing === s.id ? "Cancel" : cur ? "Record an improvement" : "Rate"}</button>
                    <button className="link" onClick={() => setEditingSkill(editingSkill === s.id ? null : s.id)}>
                      {editingSkill === s.id ? "Close" : "Edit"}</button>
                  </div>
                  {editingSkill === s.id && <EditSkill skill={s} sk={sk} onDone={() => setEditingSkill(null)} />}
                  {cur?.note && <div className="muted small">{cur.note}</div>}
                  {editing === s.id && <RateForm skill={s} current={cur?.rating ?? null} sk={sk} onDone={() => setEditing(null)} />}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

/** The category's label on the CV (German / English) and its row order there. */
function CategoryLabels({ cat, sk }: { cat: string; sk: ReturnType<typeof useSkills> }) {
  const cur = sk.categories.find((c) => c.category === cat);
  const [de, setDe] = useState(cur?.label_de ?? "");
  const [en, setEn] = useState(cur?.label_en ?? "");
  const [order, setOrder] = useState(cur?.cv_order ?? 100);
  const [saved, setSaved] = useState(false);
  async function save() {
    const row: Category = { category: cat, label_de: de.trim() || null, label_en: en.trim() || null, cv_order: order };
    const { error } = await supabase.from("skill_categories").upsert(row, { onConflict: "category" });
    if (error) return;
    sk.setCategories((cs) => [...cs.filter((c) => c.category !== cat), row]);
    setSaved(true); setTimeout(() => setSaved(false), 1500);
  }
  return (
    <div className="row small-text cat-labels">
      <span className="muted">CV row:</span>
      <input placeholder="German label, e.g. Programmierung & Datenbanken" value={de} onChange={(e) => setDe(e.target.value)} onBlur={save} />
      <input placeholder="English label, e.g. Programming & databases" value={en} onChange={(e) => setEn(e.target.value)} onBlur={save} />
      <input type="number" min={1} max={99} value={order} onChange={(e) => setOrder(Number(e.target.value))} onBlur={save} title="Order on the CV" aria-label="Order on the CV" />
      {saved && <span className="muted">saved</span>}
    </div>
  );
}

/** Rename a skill, edit its aliases, category and parent (the database is the only place skills are edited). */
function EditSkill({ skill, sk, onDone }: { skill: Skill; sk: ReturnType<typeof useSkills>; onDone: () => void }) {
  const [name, setName] = useState(skill.name);
  const [aliases, setAliases] = useState(skill.aliases.filter((a) => a !== skill.name_key).join(", "));
  const [category, setCategory] = useState(skill.category ?? "");
  const [parent, setParent] = useState(skill.parent_id ?? "");
  const [err, setErr] = useState<string | null>(null);
  const cats = [...new Set((sk.catalog ?? []).map((s) => s.category).filter(Boolean))] as string[];
  async function save() {
    const n = name.trim();
    if (!n) return;
    const fields = {
      name: n, name_key: keyOf(n), category: category || null, parent_id: parent || null,
      aliases: [...new Set([keyOf(n), ...aliases.split(",").map(keyOf).filter(Boolean)])],
    };
    const { error } = await supabase.from("skills").update(fields).eq("id", skill.id);
    if (error) return setErr(error.code === "23505" ? "Another skill has that name." : error.message);
    sk.setCatalog((c) => (c ?? []).map((s) => (s.id === skill.id ? { ...s, ...fields } : s)));
    scheduleRerank();
    onDone();
  }
  async function remove() {
    if (!window.confirm(`Remove “${skill.name}” from the catalogue? Its ratings are kept in the history.`)) return;
    const { error } = await supabase.from("skills").update({ deleted_at: new Date().toISOString() }).eq("id", skill.id);
    if (error) return setErr(error.message);
    sk.setCatalog((c) => (c ?? []).filter((s) => s.id !== skill.id));
    scheduleRerank();
    onDone();
  }
  return (
    <div className="register">
      <div className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
        <select value={parent} onChange={(e) => setParent(e.target.value)} aria-label="Variant of">
          <option value="">Not a variant</option>
          {(sk.catalog ?? []).filter((s) => !s.parent_id && s.id !== skill.id).map((s) => <option key={s.id} value={s.id}>variant of {s.name}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">No category</option>
          {cats.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
        </select>
      </div>
      <input className="wide-input" placeholder="Other names in job ads, comma-separated (e.g. ms sql server, mssql)" value={aliases}
             onChange={(e) => setAliases(e.target.value)} />
      <div className="row">
        <button className="primary small" disabled={!name.trim()} onClick={save}>Save</button>
        <button className="link danger" onClick={remove}>Remove skill</button>
      </div>
      {err && <p className="notice">{err}</p>}
    </div>
  );
}

function RateForm({ skill, current, sk, onDone }: { skill: Skill; current: number | null; sk: ReturnType<typeof useSkills>; onDone: () => void }) {
  const [rating, setRating] = useState<number>(current ?? 3);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    const { data, error } = await supabase.from("skill_ratings").insert({ skill_id: skill.id, rating, note: note.trim() || null })
      .select("skill_id,rating,note,rated_at").single();
    if (error) return setErr(error.message);
    sk.setHistory((h) => [...h, data as never]);
    scheduleRerank();
    onDone();
  }
  return (
    <div className="register">
      <div className="row">
        <select value={rating} onChange={(e) => setRating(Number(e.target.value))} aria-label="Rating">
          {Array.from({ length: 11 }, (_, i) => <option key={i} value={i}>{i}/10{ANCHORS[i] ? ` – ${ANCHORS[i]}` : ""}</option>)}
        </select>
        <input placeholder={current == null ? "Evidence (optional): where you used it" : "What changed (optional): a course, a project, a job…"}
               value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="primary small" disabled={rating === current} onClick={save}>{current == null ? "Save rating" : "Record"}</button>
      </div>
      {err && <p className="notice">{err}</p>}
    </div>
  );
}

function AddSkill({ sk, onDone, name: initial = "", parent: initialParent = null }: {
  sk: ReturnType<typeof useSkills>; onDone: (s?: Skill) => void; name?: string; parent?: string | null;
}) {
  const [name, setName] = useState(initial);
  const [category, setCategory] = useState("");
  const [parent, setParent] = useState<string>(initialParent ?? "");
  const [err, setErr] = useState<string | null>(null);
  const cats = [...new Set((sk.catalog ?? []).map((s) => s.category).filter(Boolean))] as string[];
  async function save() {
    const n = name.trim();
    if (!n) return;
    const { data, error } = await supabase.from("skills").insert({
      name: n, name_key: keyOf(n), aliases: [keyOf(n)], parent_id: parent || null,
      category: category || (parent ? sk.index?.byId.get(parent)?.category ?? null : null),
    }).select("id,name,name_key,parent_id,aliases,category,from_profile").single();
    if (error) return setErr(error.code === "23505" ? "That skill exists already." : error.message);
    sk.setCatalog((c) => [...(c ?? []), data as Skill]);
    scheduleRerank();
    onDone(data as Skill);
  }
  return (
    <div className="register">
      <div className="row">
        <input placeholder="Skill name, e.g. Databricks" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={parent} onChange={(e) => setParent(e.target.value)} aria-label="Variant of">
          <option value="">Not a variant</option>
          {(sk.catalog ?? []).filter((s) => !s.parent_id).map((s) => <option key={s.id} value={s.id}>variant of {s.name}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">{parent ? "Same category as parent" : "Category…"}</option>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button className="primary small" disabled={!name.trim()} onClick={save}>Add</button>
      </div>
      {err && <p className="notice">{err}</p>}
    </div>
  );
}

// -- new skills from job ads ------------------------------------------------------------------------
function NewSkills({ queue, sk }: { queue: { raw: string; jobs: number }[]; sk: ReturnType<typeof useSkills> }) {
  const [creating, setCreating] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [shown, setShown] = useState(50);

  async function alias(raw: string, skill: Skill) {
    const aliases = [...new Set([...skill.aliases, keyOf(raw)])];
    const { error } = await supabase.from("skills").update({ aliases }).eq("id", skill.id);
    if (error) return setErr(error.message);
    sk.setCatalog((c) => (c ?? []).map((s) => (s.id === skill.id ? { ...s, aliases } : s)));
    scheduleRerank();
  }
  async function ignore(raw: string) {
    const { error } = await supabase.from("skill_ignores").insert({ raw_key: keyOf(raw) });
    if (error && error.code !== "23505") return setErr(error.message);
    sk.setIgnored((i) => new Set([...i, keyOf(raw)]));
  }

  if (!queue.length) return <p className="empty">Every skill named in the job ads is in the catalogue. 🎉</p>;
  return (
    <>
      <p className="muted small">
        Skill names from job ads (last year, all jobs) that aren't in the catalogue, most frequent first. Map each once: the same skill
        under another name, a variant of a skill (counts toward it), a new skill, or not a skill / not relevant.
      </p>
      {err && <p className="notice">{err}</p>}
      <ul className="new-skills">
        {queue.slice(0, shown).map((u) => {
          const sug = suggestParent(u.raw, sk.catalog ?? []);
          return (
            <li key={u.raw}>
              <div className="rating-line">
                <strong>{u.raw}</strong><span className="muted small">{u.jobs} job{u.jobs === 1 ? "" : "s"}</span>
              </div>
              <div className="row small-text">
                {sug && <button className="small" onClick={() => setCreating(`${u.raw}|${sug.id}`)}>Variant of {sug.name}</button>}
                <select value="" onChange={(e) => { const s = sk.index?.byId.get(e.target.value); if (s) alias(u.raw, s); }} aria-label="Same as">
                  <option value="">Same as…</option>
                  {(sk.catalog ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <button className="link" onClick={() => setCreating(`${u.raw}|`)}>New skill</button>
                <button className="link danger" onClick={() => ignore(u.raw)}>Ignore</button>
              </div>
              {creating?.startsWith(`${u.raw}|`) && (
                <AddSkill sk={sk} name={u.raw} parent={creating.split("|")[1] || null}
                          onDone={async (s) => { setCreating(null); if (s) await alias(u.raw, s); }} />
              )}
            </li>
          );
        })}
      </ul>
      {queue.length > shown && <button className="link" onClick={() => setShown((n) => n + 50)}>Show more ({queue.length - shown} left)</button>}
    </>
  );
}
