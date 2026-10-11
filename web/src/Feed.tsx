import { useCallback, useEffect, useMemo, useState } from "react";
import FilterBar, { applyFilters, EMPTY, loadFilters, saveFilters, type Filters } from "./Filters";
import { POSTING_COLUMNS, SKIP_REASONS, sourceLabel, supabase, type Posting } from "./supabase";

type Tab = "new" | "applied" | "skipped" | "all";
// Applied jobs live in the Applications view; the timeline still shows them with a badge.
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "Timeline" },
  { key: "new", label: "To triage" },
  { key: "skipped", label: "Skipped" },
];
const TAB_KEY = "jobsignal.feed.tab";
const REMOTE: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" };
const HISTORY_DAYS = 30;

function loadTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY) as Tab | null;
    return t && TABS.some((x) => x.key === t) ? t : "all";
  } catch {
    return "all";
  }
}

// Group by the local day the pipeline first found the job: every job that passed
// the filters appears, including ones beyond the email's item cap.
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(key: string): string {
  const today = dayKey(new Date().toISOString());
  const yesterday = dayKey(new Date(Date.now() - 86400000).toISOString());
  const date = new Date(key + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
  return key === today ? `Today · ${date}` : key === yesterday ? `Yesterday · ${date}` : date;
}

// Within a day: ranked jobs by score, then not-yet-analysed ones (spec 7.9).
const byRank = (a: Posting, b: Posting) =>
  (b.rank_score ?? -1) - (a.rank_score ?? -1) || (b.posted_date ?? "").localeCompare(a.posted_date ?? "");

// Group by the date the job was posted; the day it was found only when the source gives no date
// (a newly watched company's existing jobs keep their real dates).
const postedKey = (r: Posting) => r.posted_date ?? dayKey(r.first_seen_at);

function groupByDay(rows: Posting[]): [string, Posting[]][] {
  const groups = new Map<string, Posting[]>();
  for (const r of rows) {
    const k = postedKey(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))          // newest posting date first
    .map(([k, items]) => [k, items.sort(byRank)]);
}

export default function Feed() {
  const [tab, setTab] = useState<Tab>(loadTab);
  const [rows, setRows] = useState<Posting[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const since = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString();
    let q = supabase
      .from("job_postings")
      .select(POSTING_COLUMNS)
      .eq("filter_status", "passed")
      .is("deleted_at", null)
      .gte("first_seen_at", since)
      .order("first_seen_at", { ascending: false })
      .order("posted_date", { ascending: false, nullsFirst: false })
      .limit(2000);
    if (tab !== "all") q = q.eq("triage_status", tab);
    const { data, error } = await q;
    if (error) setError(error.message);
    else setRows(data as unknown as Posting[]);
  }, [tab]);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* per-browser convenience only */
    }
    setRows(null);
    load();
  }, [tab, load]);

  const replace = (p: Posting) => setRows((rs) => rs && rs.map((r) => (r.id === p.id ? p : r)));
  const remove = (id: string) => setRows((rs) => rs && rs.filter((r) => r.id !== id));

  const [accounts, setAccounts] = useState<Account[]>([]);
  useEffect(() => {
    supabase.from("portal_accounts").select("company_name,login_email,portal_domain").is("deleted_at", null)
      .then(({ data }) => data && setAccounts(data as Account[]));
  }, []);

  const [filters, setFilters] = useState<Filters>(loadFilters);
  const changeFilters = (f: Filters) => { setFilters(f); saveFilters(f); };
  const visible = useMemo(() => (rows ? applyFilters(rows, filters) : null), [rows, filters]);
  const sources = useMemo(() => [...new Set((rows ?? []).map((r) => r.source))].sort(), [rows]);

  return (
    <>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <FilterBar value={filters} onChange={changeFilters} sources={sources}
                 shown={visible?.length ?? 0} total={rows?.length ?? 0} />
      {error && <p className="notice">{error}</p>}
      {rows === null || visible === null ? (
        <p className="empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="empty">{tab === "new" ? "Nothing to triage. 🎉" : "Nothing here yet."}</p>
      ) : visible.length === 0 ? (
        <p className="empty">
          No jobs match these filters. <button className="link" onClick={() => changeFilters(EMPTY)}>Clear filters</button>
        </p>
      ) : (
        groupByDay(visible).map(([day, items]) => {
          const open = items.filter((p) => p.triage_status === "new").length;
          return (
            <section key={day}>
              <h2 className="day">
                {dayLabel(day)}
                <span className="day-count">
                  {items.length} job{items.length === 1 ? "" : "s"}
                  {tab === "all" && open > 0 ? ` · ${open} to triage` : ""}
                </span>
              </h2>
              <div className="grid">
                {items.map((p) => (
                  <Card key={p.id} p={p} tab={tab} onChange={replace} onGone={remove} onError={setError}
                        account={accountFor(p.company_name, accounts)} />
                ))}
              </div>
            </section>
          );
        })
      )}
      {rows !== null && rows.length > 0 && (
        <p className="empty">Jobs found in the last {HISTORY_DAYS} days, grouped by the date they were posted.</p>
      )}
    </>
  );
}

function Card({ p, tab, onChange, onGone, onError, account }: {
  account?: Account;
  p: Posting;
  tab: Tab;
  onChange: (p: Posting) => void;
  onGone: (id: string) => void;
  onError: (msg: string) => void;
}) {
  const [skipping, setSkipping] = useState(false);
  const [busy, setBusy] = useState(false);
  const url = p.apply_url ?? p.source_url ?? undefined;

  async function triage(action: "apply" | "skip" | "reset", reason?: string) {
    // Open the tab synchronously so the browser doesn't block it as a pop-up.
    const win = action === "apply" && url ? window.open("about:blank", "_blank") : null;
    setBusy(true);
    const { data, error } = await supabase.rpc("triage_posting", {
      p_posting_id: p.id, p_action: action, p_reason: reason ?? null,
    });
    setBusy(false);
    setSkipping(false);
    if (error) {
      win?.close();
      return onError(error.message);
    }
    if (win && url) win.location.href = url;
    const next = { ...p, triage_status: data.triage_status, skip_reason: data.skip_reason };
    if (tab !== "all" && next.triage_status !== tab) onGone(p.id);
    else onChange(next);
  }

  async function del() {
    if (p.triage_status === "applied" && !window.confirm("This job has an application. Delete both?")) return;
    const now = new Date().toISOString();
    const { error } = await supabase.from("job_postings").update({ deleted_at: now }).eq("id", p.id);
    if (error) return onError(error.message);
    if (p.triage_status === "applied") {
      await supabase.from("applications").update({ deleted_at: now }).eq("job_posting_id", p.id);
    }
    onGone(p.id);
  }

  async function save(field: keyof Posting, value: string) {
    const v = value.trim() || null;
    if (v === p[field]) return;
    const { data, error } = await supabase.from("job_postings").update({ [field]: v }).eq("id", p.id)
      .select(POSTING_COLUMNS).single();
    if (error) return onError(error.message);
    onChange(data as unknown as Posting);
  }

  const nLoc = p.location_raw ? p.location_raw.split("; ").length : 0;
  const meta = [
    nLoc > 1 ? `+${nLoc - 1}` : null,
    p.remote_policy ? REMOTE[p.remote_policy] : null,
    p.posted_date ? fmtDate(p.posted_date) : null,
  ].filter(Boolean);

  return (
    <div className={`card${p.triage_status !== "new" ? " done" : ""}`}>
      <div className="tags">
        <span className={`source source-${p.source}`}>{sourceLabel(p.source)}</span>
        {p.poster_type === "agency" && <span className="badge">agency</span>}
        {p.triage_status !== "new" && (
          <span className="badge">
            {p.triage_status}{p.skip_reason ? `: ${label(p.skip_reason)}` : ""}
          </span>
        )}
        {p.manually_edited && <span className="badge">edited</span>}
        {account && <span className="badge account" title={account.portal_domain ?? undefined}>account: {account.login_email}</span>}
      </div>
      <div className="title">
        <Editable value={p.title} onSave={(v) => save("title", v)} />
        {url && <> <a href={url} target="_blank" rel="noreferrer" aria-label="Open posting">↗</a></>}
      </div>
      <div className="company">
        <Editable value={p.company_name} onSave={(v) => save("company_name", v)} />
      </div>
      <div className="meta">
        <Editable value={p.city ?? ""} placeholder="city" onSave={(v) => save("city", v)} />
        {meta.length > 0 && ` · ${meta.join(" · ")}`}
      </div>
      <div className="meta">
        <Editable value={p.salary_text ?? ""} placeholder="no salary given" onSave={(v) => save("salary_text", v)} />
      </div>
      <Why p={p} />
      <div className="actions">
        {p.triage_status === "new" && (
          <>
            <button className="primary" disabled={busy} onClick={() => triage("apply")}>Apply</button>
            <button disabled={busy} onClick={() => setSkipping((s) => !s)}>Skip</button>
          </>
        )}
        {p.triage_status === "skipped" && (
          <button disabled={busy} onClick={() => triage("reset")}>Undo skip</button>
        )}
        <a className="link-button" href={`#job/${p.id}`} title="Open the job with its notepad (Cmd-click: new browser tab)">
          {p.notes ? "📝 Notes" : "Open"}
        </a>
        <button className="link danger" disabled={busy} onClick={del}>Delete</button>
      </div>
      {skipping && (
        <div className="reasons">
          {SKIP_REASONS.map((r) => (
            <button key={r.key} className="chip" disabled={busy} onClick={() => triage("skip", r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Why it ranked: skill match, missing skills, language and experience requirements. */
export function Why({ p }: { p: Posting }) {
  if (p.extraction_status !== "done") {
    return p.extraction_status === "skipped" ? null : <div className="why muted">Not analysed yet</div>;
  }
  const matched = p.rank_details?.matched ?? [];
  const missing = p.rank_details?.missing ?? [];
  const total = matched.length + missing.length;
  const reqs = [
    p.german_level === "none" ? "no German needed" : p.german_level ? `German ${p.german_level}` : null,
    p.required_years != null ? `${p.required_years}+ yrs` : null,
  ].filter(Boolean);
  return (
    <div className="why">
      {total > 0 && (
        <div className="skills">
          <span className="score" title="Rank score">{Math.round(p.rank_score ?? 0)}</span>
          <span className="muted">{matched.length}/{total} skills</span>
          {matched.slice(0, 5).map((s) => <span key={s} className="skill hit">{s}</span>)}
          {missing.slice(0, 4).map((s) => <span key={s} className="skill miss">{s}</span>)}
        </div>
      )}
      {reqs.length > 0 && <div className="muted">{reqs.join(" · ")}</div>}
    </div>
  );
}

function Editable({ value, placeholder, onSave }: {
  value: string;
  placeholder?: string;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <span className="editable" title="Click to edit" onClick={() => { setDraft(value); setEditing(true); }}>
        {value || <span style={{ opacity: 0.5 }}>{placeholder}</span>}
      </span>
    );
  }
  return (
    <input
      className="edit"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); onSave(draft); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") { setDraft(value); setEditing(false); }
      }}
    />
  );
}

export function label(reason: string) {
  return SKIP_REASONS.find((r) => r.key === reason)?.label ?? reason;
}

export function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

// Existing portal account at this company (spec 7.6): shown before applying, to avoid duplicates.
type Account = { company_name: string; login_email: string; portal_domain: string | null };
const LEGAL = /\b(gmbh|ag|se|kg|kgaa|ug|ohg|gbr|e\.?v|inc|ltd|llc|bv|sa|plc|co|corp|& co)\b\.?/g;
const norm = (s: string) => s.toLowerCase().replace(LEGAL, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function accountFor(company: string, accounts: Account[]): Account | undefined {
  const c = norm(company);
  if (c.length < 3) return undefined;
  return accounts.find((a) => {
    const n = norm(a.company_name);
    return n.length >= 3 && (n === c || ` ${c} `.includes(` ${n} `) || ` ${n} `.includes(` ${c} `));
  });
}
