import { useCallback, useEffect, useState } from "react";
import { POSTING_COLUMNS, SKIP_REASONS, supabase, type Posting } from "./supabase";

type Tab = "new" | "applied" | "skipped" | "all";
const TABS: { key: Tab; label: string }[] = [
  { key: "new", label: "To triage" },
  { key: "applied", label: "Applied" },
  { key: "skipped", label: "Skipped" },
  { key: "all", label: "All" },
];
const TAB_KEY = "jobsignal.feed.tab";
const REMOTE: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" };

function loadTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY) as Tab | null;
    return t && TABS.some((x) => x.key === t) ? t : "new";
  } catch {
    return "new";
  }
}

export default function Feed() {
  const [tab, setTab] = useState<Tab>(loadTab);
  const [rows, setRows] = useState<Posting[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    let q = supabase
      .from("job_postings")
      .select(POSTING_COLUMNS)
      .eq("filter_status", "passed")
      .is("deleted_at", null)
      .order("surfaced_on", { ascending: false, nullsFirst: false })
      .order("first_seen_at", { ascending: false })
      .limit(300);
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

  return (
    <div className="wrap">
      <header>
        <h1>jobsignal</h1>
        <button className="link" onClick={() => supabase.auth.signOut()}>Log out</button>
      </header>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {error && <p className="notice">{error}</p>}
      {rows === null ? (
        <p className="empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="empty">{tab === "new" ? "Nothing to triage. 🎉" : "Nothing here yet."}</p>
      ) : (
        rows.map((p) => (
          <Card key={p.id} p={p} tab={tab} onChange={replace} onGone={remove} onError={setError} />
        ))
      )}
    </div>
  );
}

function Card({ p, tab, onChange, onGone, onError }: {
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
    nLoc > 1 ? `+${nLoc - 1} locations` : null,
    p.remote_policy ? REMOTE[p.remote_policy] : null,
    p.posted_date ? `posted ${fmtDate(p.posted_date)}` : null,
  ].filter(Boolean);

  return (
    <div className={`card${p.triage_status !== "new" ? " done" : ""}`}>
      <div className="title">
        <Editable value={p.title} onSave={(v) => save("title", v)} />
        {url && <> <a href={url} target="_blank" rel="noreferrer" aria-label="Open posting">↗</a></>}
        {p.triage_status !== "new" && (
          <span className="badge">
            {p.triage_status}{p.skip_reason ? `: ${label(p.skip_reason)}` : ""}
          </span>
        )}
        {p.manually_edited && <span className="badge">edited</span>}
      </div>
      <div className="meta">
        <Editable value={p.company_name} onSave={(v) => save("company_name", v)} />
        {" · "}
        <Editable value={p.city ?? ""} placeholder="city" onSave={(v) => save("city", v)} />
        {meta.length > 0 && ` · ${meta.join(" · ")}`}
        {" · "}
        <Editable value={p.salary_text ?? ""} placeholder="salary" onSave={(v) => save("salary_text", v)} />
        {p.poster_type === "agency" && <span className="badge">agency</span>}
      </div>
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

function label(reason: string) {
  return SKIP_REASONS.find((r) => r.key === reason)?.label ?? reason;
}

function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
