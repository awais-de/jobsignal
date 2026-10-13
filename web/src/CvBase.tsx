import { useCallback, useEffect, useMemo, useState } from "react";
import { parseCv, type ParsedCV } from "./cvtex";
import { supabase } from "./supabase";

// Base CV versions (Profile page): upload or paste the LaTeX of a master CV, per language. Every upload
// is a new version; tailored CVs record which version they came from.

export type BaseCv = { id: string; lang: "de" | "en"; version: number; label: string | null; tex_source: string; created_at: string };
export const BASE_COLUMNS = "id,lang,version,label,tex_source,created_at";

export function summary(cv: ParsedCV): string {
  const bullets = cv.sections.reduce((n, s) => n + (s.kind === "entries" ? s.entries.reduce((m, e) => m + e.bullets.length, 0) : 0), 0);
  const raw = cv.sections.filter((s) => s.kind === "raw").map((s) => s.title);
  return `${cv.sections.length} sections, ${bullets} bullets` + (raw.length ? ` · kept as is: ${raw.join(", ")}` : "");
}

export function BaseCvs() {
  const [list, setList] = useState<BaseCv[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("base_cvs").select(BASE_COLUMNS).is("deleted_at", null)
      .order("lang").order("version", { ascending: false });
    if (error) return setError(error.message);
    setList(data as BaseCv[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function remove(b: BaseCv) {
    if (!window.confirm(`Remove ${b.lang.toUpperCase()} v${b.version}? CVs already made from it keep their record.`)) return;
    const { error } = await supabase.from("base_cvs").update({ deleted_at: new Date().toISOString() }).eq("id", b.id);
    if (error) return setError(error.message);
    load();
  }

  function download(b: BaseCv) {
    const url = URL.createObjectURL(new Blob([b.tex_source], { type: "application/x-tex" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `base_cv_${b.lang}_v${b.version}.tex` });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="card">
      <h3>Base CVs</h3>
      <p className="muted">
        Your master CVs in LaTeX, German and English. Every upload becomes a new version; the CV builder on each job starts
        from one, and each tailored CV remembers which, so you can compare versions later.
      </p>
      {error && <p className="notice">{error}</p>}
      {list && list.length === 0 && <p className="muted">None yet.</p>}
      {list && list.length > 0 && (
        <ul className="base-list">
          {list.map((b) => {
            let info: string;
            try { info = summary(parseCv(b.tex_source)); } catch (e) { info = e instanceof Error ? e.message : "can't be read"; }
            return (
              <li key={b.id}>
                <strong>{b.lang.toUpperCase()} v{b.version}</strong>
                {b.label && <span> · {b.label}</span>}
                <span className="muted"> · {new Date(b.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} · {info}</span>
                <button className="link" onClick={() => download(b)}>.tex</button>
                <button className="link danger" onClick={() => remove(b)}>Remove</button>
              </li>
            );
          })}
        </ul>
      )}
      <button className="small" onClick={() => setAdding((a) => !a)}>{adding ? "Cancel" : "+ Upload a base CV"}</button>
      {adding && <UploadBase existing={list ?? []} onError={setError} onSaved={() => { setAdding(false); load(); }} />}
    </section>
  );
}

function UploadBase({ existing, onSaved, onError }: { existing: BaseCv[]; onSaved: () => void; onError: (m: string) => void }) {
  const [tex, setTex] = useState("");
  const [lang, setLang] = useState<"de" | "en">("de");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => {
    if (!tex.trim()) return null;
    try { return { cv: parseCv(tex), error: null }; } catch (e) { return { cv: null, error: e instanceof Error ? e.message : "Can't read it." }; }
  }, [tex]);
  // The document's babel language is a good default.
  useEffect(() => {
    if (/\\usepackage\[[^\]]*ngerman[^\]]*\]\{babel\}/.test(tex)) setLang("de");
    else if (/\\usepackage\[[^\]]*english[^\]]*\]\{babel\}/.test(tex)) setLang("en");
  }, [tex]);

  async function save() {
    if (!parsed?.cv) return;
    setBusy(true);
    const version = Math.max(0, ...existing.filter((b) => b.lang === lang).map((b) => b.version)) + 1;
    const { error } = await supabase.from("base_cvs").insert({ lang, version, label: label.trim() || null, tex_source: tex });
    setBusy(false);
    if (error) return onError(error.code === "23505" ? "That version number exists already: reload and try again." : error.message);
    onSaved();
  }

  return (
    <div className="register">
      <div className="row">
        <input type="file" accept=".tex,text/x-tex,text/plain"
               onChange={async (e) => { const f = e.target.files?.[0]; if (f) setTex(await f.text()); e.target.value = ""; }} />
        <span className="muted small">or paste it below</span>
      </div>
      <textarea rows={6} className="mono" placeholder="\documentclass… \begin{document} … \end{document}" value={tex}
                onChange={(e) => setTex(e.target.value)} />
      {parsed?.error && <p className="notice">{parsed.error}</p>}
      {parsed?.cv && (
        <p className="small">
          Read: <strong>{parsed.cv.name ?? "no name found"}</strong>{parsed.cv.headline ? ` · “${parsed.cv.headline.plain}”` : ""} ·{" "}
          {parsed.cv.sections.map((s) => s.title).join(", ")} · {summary(parsed.cv)}
        </p>
      )}
      <div className="row">
        <select value={lang} onChange={(e) => setLang(e.target.value as "de" | "en")} aria-label="Language">
          <option value="de">German</option>
          <option value="en">English</option>
        </select>
        <input placeholder="Label (optional), e.g. data engineering focus" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="primary small" disabled={!parsed?.cv || busy} onClick={save}>
          Save as {lang.toUpperCase()} v{Math.max(0, ...existing.filter((b) => b.lang === lang).map((b) => b.version)) + 1}
        </button>
      </div>
    </div>
  );
}
