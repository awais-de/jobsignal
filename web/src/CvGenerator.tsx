import { useCallback, useEffect, useState } from "react";
import CvBuilder, { type AdHoc } from "./CvBuilder";
import { supabase } from "./supabase";

// CVs made whenever needed (Me → CVs; owner request 2026-10-19): the job page's CV generator without a job.
// Each one is a named draft ("General DE", "Research EN") kept for reuse; duplicate one to start the next.

type Row = AdHoc & { updated_at: string };
const COLUMNS = "id,name,base_cv_id,updated_at";
const OPEN_KEY = "jobsignal.cvs.open";

export default function CvGenerator() {
  const [list, setList] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<string | null>(() => { try { return localStorage.getItem(OPEN_KEY); } catch { return null; } });
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("cv_drafts").select(COLUMNS).is("job_posting_id", null).order("updated_at", { ascending: false });
    if (error) return setError(error.message);
    setList(data as Row[]);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { try { if (open) localStorage.setItem(OPEN_KEY, open); else localStorage.removeItem(OPEN_KEY); } catch { /* convenience only */ } }, [open]);

  async function create(fromId?: string) {
    const src = fromId ? list?.find((r) => r.id === fromId) : undefined;
    const label = src ? `${src.name} (copy)` : name.trim();
    if (!label) return;
    let data: unknown = { v: 0 };      // no draft yet: filled from the master CV when first opened
    if (src) {
      const r = await supabase.from("cv_drafts").select("data").eq("id", src.id).single();
      if (r.error) return setError(r.error.message);
      data = (r.data as { data: unknown }).data;
    }
    const base = src?.base_cv_id ?? (await supabase.from("base_cvs").select("id").is("deleted_at", null).order("version", { ascending: false }).limit(1)).data?.[0]?.id;
    if (!base) return setError("Upload a CV format first (Me → Master CV → CV formats).");
    const { data: row, error } = await supabase.from("cv_drafts")
      .insert({ name: label, base_cv_id: base, data }).select(COLUMNS).single();
    if (error) return setError(error.message);
    setName("");
    setList((l) => [row as Row, ...(l ?? [])]);
    setOpen((row as Row).id);
  }
  async function rename(r: Row) {
    const next = window.prompt("Name", r.name)?.trim();
    if (!next || next === r.name) return;
    const { error } = await supabase.from("cv_drafts").update({ name: next }).eq("id", r.id);
    if (error) return setError(error.message);
    setList((l) => l && l.map((x) => (x.id === r.id ? { ...x, name: next } : x)));
  }
  async function remove(r: Row) {
    if (!window.confirm(`Delete the CV "${r.name}"? PDFs already saved to Drive stay there.`)) return;
    const { error } = await supabase.from("cv_drafts").delete().eq("id", r.id);
    if (error) return setError(error.message);
    setList((l) => l && l.filter((x) => x.id !== r.id));
    if (open === r.id) setOpen(null);
  }

  const current = list?.find((r) => r.id === open) ?? null;
  return (
    <div className="cv-generator">
      <section className="card">
        <h3>CVs</h3>
        <p className="muted">
          The CV generator without a job: for a career fair, a job found elsewhere, or a general CV to keep. Each CV is saved here
          under its name; for a job in the feed, use the CV tab on its page instead.
        </p>
        {error && <p className="notice">{error} <button className="link" onClick={() => setError(null)}>×</button></p>}
        <form className="row" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <input value={name} placeholder="Name, e.g. General DE or Research EN" onChange={(e) => setName(e.target.value)} aria-label="New CV name" />
          <button className="primary small" disabled={!name.trim()}>+ New CV</button>
        </form>
        {list && list.length > 0 && (
          <ul className="cv-list">
            {list.map((r) => (
              <li key={r.id} className={r.id === open ? "active" : ""}>
                <button className="link cv-list-name" onClick={() => setOpen(r.id === open ? null : r.id)}>{r.id === open ? "▾" : "▸"} {r.name}</button>
                <span className="muted small">edited {new Date(r.updated_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}</span>
                <span className="mcv-tools">
                  <button className="link small" onClick={() => create(r.id)}>Duplicate</button>
                  <button className="link small" onClick={() => rename(r)}>Rename</button>
                  <button className="link small danger" onClick={() => remove(r)}>Delete</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {list && list.length === 0 && <p className="muted small">No CVs yet: name one above to start.</p>}
      </section>
      {current && (
        <section className="notepad cv-generator-body">
          <CvBuilder key={current.id} adhoc={current} active />
        </section>
      )}
    </div>
  );
}
