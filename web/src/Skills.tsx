import { useEffect, useMemo, useState } from "react";
import {
  ANCHORS, anchor, demand, keyOf, priority, QUADRANTS, quadrant, suggestParent, TARGET, WEIGHT,
  type Demand, type Filter, type Quadrant, type Skill,
} from "./skillmath";
import { useSkills } from "./skills-data";
import { supabase } from "./supabase";

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
      <div className="tabs">
        <button className={tab === "gaps" ? "active" : ""} onClick={() => setTab("gaps")}>Demand &amp; gaps</button>
        <button className={tab === "ratings" ? "active" : ""} onClick={() => setTab("ratings")}>My ratings</button>
        <button className={tab === "new" ? "active" : ""} onClick={() => setTab("new")}>New skills <span className="day-count">{queue.length}</span></button>
      </div>
      {tab === "gaps" && (
        <Gaps d={d} filter={filter} setFilter={setFilter} families={families} ratingOf={sk.ratingOf}
              onRate={(id) => { setFocus(id); setTab("ratings"); }} unmatched={queue.length} toNew={() => setTab("new")} />
      )}
      {tab === "ratings" && <Ratings sk={sk} focus={focus} />}
      {tab === "new" && <NewSkills queue={queue} sk={sk} />}
    </div>
  );
}

// -- demand & gaps ------------------------------------------------------------------------------
function Gaps({ d, filter, setFilter, families, ratingOf, onRate, unmatched, toNew }: {
  d: ReturnType<typeof demand>; filter: Filter; setFilter: (f: Filter) => void; families: { key: string; label: string }[];
  ratingOf: (id: string) => number | null; onRate: (id: string) => void; unmatched: number; toNew: () => void;
}) {
  const [showIgnore, setShowIgnore] = useState(false);
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
        <span className="filter-count">{d.population} analysed jobs</span>
      </div>
      <p className="muted small">
        Demand = share of these jobs asking for a skill (must-have counts {WEIGHT.must}, nice-to-have {WEIGHT.nice}); a variant also
        counts toward its parent. High demand = 15%+. Strong = rated 6+. Priority = demand × distance to {TARGET}/10.
        {unratedHigh > 0 && <> <strong>{unratedHigh} high-demand skill{unratedHigh > 1 ? "s are" : " is"} not rated yet.</strong></>}
        {unmatched > 0 && <> {unmatched} skill names from job ads aren't in the catalogue yet: <button className="link" onClick={toNew}>map them</button> for accurate figures.</>}
      </p>
      {d.population < 50 && <p className="notice">Only {d.population} jobs in this group: treat the percentages as rough until more jobs are analysed.</p>}
      {(["learn", "strength", "niche", "ignore"] as Quadrant[]).map((q) => (
        (q !== "ignore" || showIgnore) ? (
          <section key={q} className="card skill-group">
            <h3>{QUADRANTS[q]} <span className="muted small">{groups[q].length}</span></h3>
            {groups[q].length === 0 ? <p className="muted small">None.</p> : (
              <div className="table-wrap"><table className="apps">
                <thead><tr><th>Skill</th><th>Demand</th><th>Must-have</th><th>Your rating</th><th>Trend</th>{q === "learn" && <th>Priority</th>}</tr></thead>
                <tbody>
                  {groups[q].slice(0, q === "ignore" ? 200 : 60).map((r) => {
                    const rating = ratingOf(r.skill.id);
                    const trend = r.earlier + r.recent < 2 ? "–" : r.recent > r.earlier * 1.3 ? "▲" : r.recent < r.earlier * 0.7 ? "▼" : "→";
                    return (
                      <tr key={r.skill.id}>
                        <td className="strong">{r.skill.name}</td>
                        <td><div className="share"><div className="share-fill" style={{ width: pct(Math.min(1, r.share)) }} /><span>{pct(r.share)}</span></div></td>
                        <td>{pct(r.mustShare)}</td>
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

// -- my ratings (base ratings change only here) ---------------------------------------------------
function Ratings({ sk, focus }: { sk: ReturnType<typeof useSkills>; focus: string | null }) {
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(focus);
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
          <h3>{cat}</h3>
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
                  </div>
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

function RateForm({ skill, current, sk, onDone }: { skill: Skill; current: number | null; sk: ReturnType<typeof useSkills>; onDone: () => void }) {
  const [rating, setRating] = useState<number>(current ?? 3);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    const { data, error } = await supabase.from("skill_ratings").insert({ skill_id: skill.id, rating, note: note.trim() || null })
      .select("skill_id,rating,note,rated_at").single();
    if (error) return setErr(error.message);
    sk.setHistory((h) => [...h, data as never]);
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
    }).select("id,name,name_key,parent_id,aliases,category").single();
    if (error) return setErr(error.code === "23505" ? "That skill exists already." : error.message);
    sk.setCatalog((c) => [...(c ?? []), data as Skill]);
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
