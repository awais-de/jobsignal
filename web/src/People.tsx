import { useCallback, useEffect, useMemo, useState } from "react";
import { linkedinSearch, normCompany } from "./contactfinder";
import { CONTACT_COLUMNS, ContactForm, SOURCES, TYPES, type Candidate, type Contact } from "./Outreach";
import { supabase } from "./supabase";

// People: everyone you know or have found (LinkedIn connections, people you added, contacts from job
// ads and emails). Search them, see who works at companies in your feed, keep research notes, and
// add people whenever you have time. Pings stay on the Responses page; this links there.

type Person = Contact & { notes: string | null; connected_on: string | null; created_at: string };
type Job = { id: string; title: string; company_name: string; triage_status: string; lane: string | null };
type PingLite = { contact_id: string; status: string };

const COLUMNS = CONTACT_COLUMNS + ",notes,connected_on,created_at";
const PAGE = 100;
const VIEWS = [
  { key: "feed", label: "At companies in my feed" },
  { key: "applied", label: "At companies I applied to" },
  { key: "all", label: "Everyone" },
] as const;
type View = (typeof VIEWS)[number]["key"];

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data as T[]));
    if ((data as T[]).length < 1000) return out;
  }
}

/** Same rule as sameCompany, on pre-normalised names (thousands of comparisons). */
const sameNorm = (x: string, y: string) =>
  x.length >= 3 && y.length >= 3 && (x === y || ` ${y} `.includes(` ${x} `) || ` ${x} `.includes(` ${y} `));

export default function People() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [pings, setPings] = useState<PingLite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("feed");
  const [shown, setShown] = useState(PAGE);
  const [adding, setAdding] = useState<string | null>(null);     // company name, or "" for a blank form

  const load = useCallback(async () => {
    try {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const [p, j, o] = await Promise.all([
        fetchAll<Person>((a, b) => supabase.from("contacts").select(COLUMNS).is("deleted_at", null).order("full_name").range(a, b)),
        fetchAll<Job>((a, b) => supabase.from("job_postings").select("id,title,company_name,triage_status,lane")
          .eq("filter_status", "passed").is("deleted_at", null).gte("first_seen_at", since).range(a, b)),
        fetchAll<PingLite>((a, b) => supabase.from("outreach").select("contact_id,status").is("deleted_at", null).range(a, b)),
      ]);
      setPeople(p); setJobs(j); setPings(o);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load people.");
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Companies in the feed (last 30 days) and the ones applied to, by normalised name.
  const companies = useMemo(() => {
    const m = new Map<string, { name: string; jobs: Job[]; applied: boolean }>();
    for (const j of jobs) {
      const k = normCompany(j.company_name);
      const c = m.get(k) ?? { name: j.company_name, jobs: [], applied: false };
      c.jobs.push(j);
      c.applied ||= j.triage_status === "applied";
      m.set(k, c);
    }
    return m;
  }, [jobs]);

  const pingsBy = useMemo(() => {
    const m = new Map<string, { n: number; replied: number }>();
    for (const p of pings) {
      const v = m.get(p.contact_id) ?? { n: 0, replied: 0 };
      v.n++;
      if (p.status === "replied") v.replied++;
      m.set(p.contact_id, v);
    }
    return m;
  }, [pings]);

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matchesQ = (p: Person) => {
    const hay = `${p.full_name} ${p.company_name ?? ""} ${p.role_title ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };

  // Company views: people grouped under each feed company they work at.
  const groups = useMemo(() => {
    if (!people || view === "all") return [];
    const byNorm = new Map<string, Person[]>();
    for (const p of people) {
      if (!p.company_name) continue;
      const k = normCompany(p.company_name);
      byNorm.set(k, [...(byNorm.get(k) ?? []), p]);
    }
    const out: { key: string; name: string; jobs: Job[]; applied: boolean; people: Person[] }[] = [];
    for (const [ck, c] of companies) {
      if (view === "applied" && !c.applied) continue;
      const ps: Person[] = [];
      for (const [pk, list] of byNorm) if (sameNorm(ck, pk)) ps.push(...list);
      if (ps.length) out.push({ key: ck, ...c, people: ps });
    }
    return out.sort((a, b) => Number(b.applied) - Number(a.applied) || b.people.length - a.people.length);
  }, [people, companies, view]);

  if (error) return <p className="notice">{error}</p>;
  if (!people) return <p className="empty">Loading…</p>;

  const replace = (c: Contact) => setPeople((ps) => {
    if (!ps) return ps;
    const updated = { ...(ps.find((x) => x.id === c.id) ?? { notes: null, connected_on: null, created_at: new Date().toISOString() }), ...c } as Person;
    return c.deleted_at ? ps.filter((x) => x.id !== c.id) : ps.some((x) => x.id === c.id) ? ps.map((x) => (x.id === c.id ? updated : x)) : [...ps, updated];
  });
  const everyone = people.filter(matchesQ);
  const nConn = people.filter((p) => p.source === "connections").length;

  return (
    <div className="people">
      <div className="responses-bar">
        <h2>People</h2>
        <input className="search" placeholder="Search a name, company or position…" value={q}
               onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} />
        <button className="small" onClick={() => setAdding(adding === null ? "" : null)}>{adding === "" ? "Cancel" : "+ Add a person"}</button>
      </div>
      <p className="muted small">
        {people.length.toLocaleString("en-GB")} people: {nConn.toLocaleString("en-GB")} LinkedIn connections and{" "}
        {people.length - nConn} you added or found in job ads. Companies in your feed = jobs that passed your filters in the last 30 days.
      </p>
      {adding === "" && (
        <ContactForm company="" candidate={null} onError={setError}
                     onSaved={(c) => { replace(c); setAdding(null); }} />
      )}
      <div className="tabs">
        {VIEWS.map((v) => (
          <button key={v.key} className={view === v.key ? "active" : ""} onClick={() => { setView(v.key); setShown(PAGE); }}>{v.label}</button>
        ))}
      </div>

      {view === "all" ? (
        <>
          <ul className="people-list">
            {everyone.slice(0, shown).map((p) => (
              <PersonRow key={p.id} p={p} pings={pingsBy.get(p.id)} onChange={replace} onError={setError} />
            ))}
          </ul>
          {everyone.length === 0 && <p className="empty">Nobody matches.</p>}
          {everyone.length > shown && (
            <button className="link" onClick={() => setShown((n) => n + PAGE)}>Show more ({everyone.length - shown} left)</button>
          )}
        </>
      ) : (
        <>
          {groups.length === 0 && <p className="empty">None of your contacts works at {view === "applied" ? "a company you applied to" : "a company in your feed"} yet.</p>}
          {groups.map((g) => {
            const ps = g.people.filter(matchesQ);
            if (!ps.length && words.length && !g.name.toLowerCase().includes(q.toLowerCase())) return null;
            return (
              <section key={g.key} className="card company-group">
                <div className="person-head">
                  <strong>{g.name}</strong>
                  {g.applied && <span className="badge">applied</span>}
                  <span className="muted">{g.people.length} {g.people.length === 1 ? "person" : "people"}</span>
                </div>
                <div className="small-text company-jobs">
                  {g.jobs.slice(0, 4).map((j) => (
                    <a key={j.id} href={`#job/${j.id}`}>{j.title}{j.lane === "explore" ? " (explore)" : ""}</a>
                  ))}
                  {g.jobs.length > 4 && <span className="muted">+{g.jobs.length - 4} more</span>}
                </div>
                <ul className="people-list">
                  {(ps.length ? ps : g.people).map((p) => (
                    <PersonRow key={p.id} p={p} pings={pingsBy.get(p.id)} onChange={replace} onError={setError} />
                  ))}
                </ul>
                <div className="search-links small-text">
                  <span className="muted">Research:</span>
                  <a href={linkedinSearch(`${g.name} recruiter`)} target="_blank" rel="noreferrer">Recruiters</a>
                  <a href={linkedinSearch(`${g.name} head of data`)} target="_blank" rel="noreferrer">Data leads</a>
                  <a href={linkedinSearch(`${g.name} data`)} target="_blank" rel="noreferrer">Data people</a>
                  <button className="link" onClick={() => setAdding(adding === g.name ? null : g.name)}>
                    {adding === g.name ? "Cancel" : `+ Add a person at ${g.name}`}
                  </button>
                </div>
                {adding === g.name && (
                  <ContactForm company={g.name} candidate={null} onError={setError}
                               onSaved={(c) => { replace(c); setAdding(null); }} />
                )}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

function PersonRow({ p, pings, onChange, onError }: {
  p: Person; pings?: { n: number; replied: number };
  onChange: (c: Contact) => void; onError: (m: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState(p.notes ?? "");

  async function saveNotes() {
    const v = notes.trim() || null;
    if (v === (p.notes ?? null)) return;
    const { error } = await supabase.from("contacts").update({ notes: v }).eq("id", p.id);
    if (error) return onError(error.message);
    onChange({ ...p, notes: v } as Contact);
  }

  async function remove() {
    if (!window.confirm(`Remove ${p.full_name}? (A later Connections.csv import keeps them removed.)`)) return;
    const { error } = await supabase.from("contacts").update({ deleted_at: new Date().toISOString(), manually_edited: true }).eq("id", p.id);
    if (error) return onError(error.message);
    onChange({ ...p, deleted_at: new Date().toISOString() });
  }

  const candidate: Candidate = {
    key: p.id, name: p.full_name, role: p.role_title, type: p.contact_type ?? (p.source === "connections" ? "referral" : "other"),
    source: p.source, email: p.email, phone: p.phone, linkedin: p.linkedin_url, contactId: p.id, best: "linkedin",
  };

  return (
    <li>
      <div className="person-line">
        <strong>{p.full_name}</strong>
        <span className="muted">
          {[p.role_title, p.company_name].filter(Boolean).join(" · ")}
          {p.contact_type && p.contact_type !== "referral" ? ` · ${TYPES[p.contact_type]}` : ""}
          {" · "}{SOURCES[p.source]}{p.connected_on ? ` since ${new Date(p.connected_on).getFullYear()}` : ""}
        </span>
        {pings && (
          <a className={`status ${pings.replied ? "status-green" : "status-blue"}`} href={`#responses`}
             title="See the messages on the Responses page">
            {pings.replied ? `${pings.replied} of ${pings.n} replied` : `${pings.n} pinged`}
          </a>
        )}
      </div>
      <div className="row small-text">
        {p.linkedin_url && <a href={p.linkedin_url} target="_blank" rel="noreferrer">LinkedIn ↗</a>}
        {!p.linkedin_url && <a href={linkedinSearch(`${p.full_name} ${p.company_name ?? ""}`)} target="_blank" rel="noreferrer">Find on LinkedIn</a>}
        {p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}
        <button className="link" onClick={() => setNotesOpen((o) => !o)}>{p.notes ? "Notes ●" : "Notes"}</button>
        <button className="link" onClick={() => setEditing((e) => !e)}>{editing ? "Cancel" : "Edit"}</button>
        <button className="link danger" onClick={remove}>Remove</button>
      </div>
      {notesOpen && (
        <textarea className="person-notes" rows={3} value={notes} placeholder="Research notes: what they work on, how you know them, what to ask…"
                  onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} />
      )}
      {editing && (
        <ContactForm company={p.company_name ?? ""} candidate={candidate} onError={onError}
                     onSaved={(c) => { onChange(c); setEditing(false); }} />
      )}
    </li>
  );
}
