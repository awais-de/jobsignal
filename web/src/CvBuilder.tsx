import { useCallback, useEffect, useMemo, useState } from "react";
import { adLanguage } from "./contactfinder";
import { BASE_COLUMNS, type BaseCv } from "./CvBase";
import {
  cvFileName, emptyDraft, entryOn, parseCv, plainCv, renderCv, rowOn, type Draft, type Entry, type Field, type ParsedCV,
} from "./cvtex";
import { useSkills } from "./skills-data";
import { supabase } from "./supabase";

// CV builder on a job's page: start from a base version, tick the bullets that fit (all start off), edit
// them for this job, check the job's keywords, then compile to PDF, download it or save it to Drive as a
// registered resume version. Edits live in this browser session only; nothing goes back to the base.

type Build = {
  id: string; status: "queued" | "compiling" | "compiled" | "failed" | "saved"; pages: number | null;
  error: string | null; file_name: string; pdf_path: string | null; created_at: string;
  resume_id: string | null; resumes?: { uid: string; drive_url: string | null } | null;
};
const BUILD_COLUMNS = "id,status,pages,error,file_name,pdf_path,created_at,resume_id,resumes(uid,drive_url)";

const draftKey = (jobId: string, baseId: string) => `jobsignal.cvdraft.${jobId}.${baseId}`;
function loadDraft(jobId: string, baseId: string): Draft {
  try { return { ...emptyDraft(), ...JSON.parse(sessionStorage.getItem(draftKey(jobId, baseId)) ?? "{}") }; } catch { return emptyDraft(); }
}

export default function CvBuilder({ job, active }: {
  job: { id: string; title: string; company_name: string; description: string | null;
         must_have_skills: string[] | null; nice_to_have_skills: string[] | null };
  active: boolean;
}) {
  const [bases, setBases] = useState<BaseCv[] | null>(null);
  const [baseId, setBaseId] = useState<string>("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sk = useSkills(false);

  useEffect(() => {
    supabase.from("base_cvs").select(BASE_COLUMNS).is("deleted_at", null).order("version", { ascending: false })
      .then(({ data, error }) => {
        if (error) return setError(error.message);
        const list = data as BaseCv[];
        setBases(list);
        // Latest version in the ad's language, else the latest of the other.
        const lang = adLanguage(job.description);
        setBaseId((cur) => cur || (list.find((b) => b.lang === lang) ?? list[0])?.id || "");
      });
  }, [job.description]);

  const base = bases?.find((b) => b.id === baseId) ?? null;
  const parsed = useMemo<{ cv: ParsedCV | null; error: string | null }>(() => {
    if (!base) return { cv: null, error: null };
    try { return { cv: parseCv(base.tex_source), error: null }; } catch (e) { return { cv: null, error: e instanceof Error ? e.message : "Can't read it." }; }
  }, [base]);
  const cv = parsed.cv;

  // Session-only draft per job and base version.
  useEffect(() => { if (baseId) setDraft(loadDraft(job.id, baseId)); }, [job.id, baseId]);
  useEffect(() => {
    if (!baseId) return;
    try { sessionStorage.setItem(draftKey(job.id, baseId), JSON.stringify(draft)); } catch { /* session convenience only */ }
  }, [draft, job.id, baseId]);

  const loadBuilds = useCallback(async () => {
    const { data } = await supabase.from("cv_builds").select(BUILD_COLUMNS).eq("job_posting_id", job.id)
      .order("created_at", { ascending: false }).limit(5);
    setBuilds((data ?? []) as unknown as Build[]);
  }, [job.id]);
  useEffect(() => { loadBuilds(); }, [loadBuilds]);
  // Poll while a build is in progress (GitHub Actions, about a minute).
  const pending = builds.some((b) => b.status === "queued" || b.status === "compiling");
  useEffect(() => {
    if (!pending || !active) return;
    const t = setInterval(loadBuilds, 4000);
    return () => clearInterval(t);
  }, [pending, active, loadBuilds]);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000); };
  const set = (f: (d: Draft) => Draft) => setDraft((d) => f({ ...d, text: { ...d.text }, on: { ...d.on }, extra: { ...d.extra } }));

  const tex = useMemo(() => (cv ? renderCv(cv, draft) : ""), [cv, draft]);
  const plain = useMemo(() => (cv ? plainCv(cv, draft) : ""), [cv, draft]);
  const fileName = cv && base ? cvFileName(base.lang, cv.name, job.company_name) : "CV.pdf";

  // Keyword check: the job's skills (extracted from the ad) against the CV's text.
  const keywords = useMemo(() => {
    const t = plain.toLowerCase();
    const has = (s: string) => t.includes(s.toLowerCase());
    return [...(job.must_have_skills ?? []).map((s) => ({ s, must: true })), ...(job.nice_to_have_skills ?? []).map((s) => ({ s, must: false }))]
      .map((k) => ({ ...k, hit: has(k.s) }));
  }, [plain, job.must_have_skills, job.nice_to_have_skills]);

  async function copyTex() {
    try { await navigator.clipboard.writeText(tex); flash("LaTeX copied: paste it into Overleaf"); } catch { flash("Couldn't copy"); }
  }
  function downloadTex() {
    const url = URL.createObjectURL(new Blob([tex], { type: "application/x-tex" }));
    Object.assign(document.createElement("a"), { href: url, download: fileName.replace(/\.pdf$/, ".tex") }).click();
    URL.revokeObjectURL(url);
  }
  async function compile() {
    if (!cv || !base) return;
    setBusy(true);
    const { data, error } = await supabase.from("cv_builds").insert({
      job_posting_id: job.id, base_cv_id: base.id, lang: base.lang, tex_source: tex, plain_text: plain, file_name: fileName,
    }).select(BUILD_COLUMNS).single();
    if (error) { setBusy(false); return setError(error.message); }
    const run = await supabase.functions.invoke("trigger-run", { body: { workflow: "cv", build_id: (data as unknown as Build).id } });
    setBusy(false);
    if (run.error) setError("The compile couldn't be started. Try again in a moment.");
    setBuilds((bs) => [data as unknown as Build, ...bs]);
  }
  async function downloadPdf(b: Build) {
    const { data, error } = await supabase.storage.from("cv-pdfs").createSignedUrl(b.pdf_path!, 120, { download: b.file_name });
    if (error || !data) return setError(error?.message ?? "No download link.");
    window.location.href = data.signedUrl;
  }
  async function saveToDrive(b: Build) {
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("cv-save", { body: { build_id: b.id, label: `${job.company_name} – ${job.title}`.slice(0, 120) } });
    setBusy(false);
    if (error || !data?.ok) {
      const detail = (data as { error?: string; detail?: string } | null);
      return setError(detail?.error === "not_configured" ? "Saving to Drive isn't set up yet (Apps Script web app)."
        : `Saving to Drive failed${detail?.detail ? `: ${detail.detail}` : ""}.`);
    }
    flash(`Saved to Drive as ${data.uid}`);
    loadBuilds();
  }

  if (bases && bases.length === 0) {
    return <p className="muted">No base CV yet. Upload one on the <a href="#profile">Profile</a> page (Base CVs), then tailor it here.</p>;
  }
  if (!bases || !base) return <p className="muted">{error ?? "Loading…"}</p>;

  return (
    <section className="cv-builder">
      <div className="notepad-head">
        <h2>CV</h2>
        <select value={baseId} onChange={(e) => setBaseId(e.target.value)} aria-label="Base CV">
          {bases.map((b) => <option key={b.id} value={b.id}>{b.lang.toUpperCase()} v{b.version}{b.label ? ` · ${b.label}` : ""}</option>)}
        </select>
        <button className="link" onClick={() => window.confirm("Start over from the base? Your edits for this job are cleared.") && setDraft(emptyDraft())}>
          Reset
        </button>
      </div>
      {error && <p className="notice">{error} <button className="link" onClick={() => setError(null)}>×</button></p>}
      {parsed.error && <p className="notice">This base version can't be read: {parsed.error}</p>}

      {keywords.length > 0 && (
        <div className="keywords">
          <span className="muted small">Job's skills in your CV:</span>
          {keywords.map((k) => (
            <span key={`${k.must}-${k.s}`} className={`skill ${k.hit ? "hit" : k.must ? "miss" : "plain"}`} title={k.must ? "Must-have" : "Nice to have"}>
              {k.hit ? "✓ " : ""}{k.s}{(() => {
                const m = sk.index?.match(k.s); const r = m ? sk.ratingOf(m.id) : null;
                return r == null ? "" : ` · ${r}/10`;
              })()}
            </span>
          ))}
          <span className="muted small">{keywords.filter((k) => k.must && k.hit).length}/{keywords.filter((k) => k.must).length} must-haves</span>
        </div>
      )}

      {cv && (
        <>
          {cv.headline && (
            <label className="cv-field">
              <span>Headline</span>
              <input value={draft.headline ?? cv.headline.plain} onChange={(e) => set((d) => ({ ...d, headline: e.target.value }))} />
            </label>
          )}
          {cv.sections.map((s) => (
            <div key={s.id} className="cv-section">
              <h3>{s.title}</h3>
              {s.kind === "paragraph" && (
                <FieldBox f={s.text} value={draft.text[s.id]} rows={4} onChange={(v) => set((d) => { d.text[s.id] = v; return d; })} />
              )}
              {s.kind === "rows" && s.rows.map((r) => (
                <div key={r.id} className={`cv-row${rowOn(r, draft) ? "" : " off"}`}>
                  <label className="check">
                    <input type="checkbox" checked={rowOn(r, draft)} onChange={(e) => set((d) => { d.on[r.id] = e.target.checked; return d; })} />
                    <strong>{r.label.plain}</strong>
                  </label>
                  {rowOn(r, draft) && <FieldBox f={r.text} value={draft.text[r.id]} rows={2} onChange={(v) => set((d) => { d.text[r.id] = v; return d; })} />}
                </div>
              ))}
              {s.kind === "entries" && s.entries.map((e) => (
                <EntryBox key={e.id} e={e} on={entryOn(e, s, draft)} projects={s.projects} draft={draft} set={set} />
              ))}
              {s.kind === "raw" && <p className="muted small">Kept exactly as in the base version.</p>}
            </div>
          ))}
        </>
      )}

      <div className="prompt-row">
        <button className="primary small" disabled={!cv || busy} onClick={compile} title="Compiles in GitHub Actions, about a minute">Compile PDF</button>
        <button className="small" disabled={!cv} onClick={copyTex}>Copy LaTeX</button>
        <button className="small" disabled={!cv} onClick={downloadTex}>Download .tex</button>
        <span className="muted small">File: {fileName}</span>
      </div>

      {builds.length > 0 && (
        <ul className="builds">
          {builds.map((b) => (
            <li key={b.id}>
              <span className="muted">{new Date(b.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>{" "}
              {(b.status === "queued" || b.status === "compiling") && <span className="status status-blue">compiling… (about a minute)</span>}
              {b.status === "failed" && <span className="status status-red">LaTeX error</span>}
              {(b.status === "compiled" || b.status === "saved") && (
                <span className={`status ${b.pages && b.pages > 2 ? "status-orange" : "status-green"}`}>{b.pages} page{b.pages === 1 ? "" : "s"}</span>
              )}
              {(b.status === "compiled" || b.status === "saved") && <button className="link" onClick={() => downloadPdf(b)}>Download PDF</button>}
              {b.status === "compiled" && <button className="small" disabled={busy} onClick={() => saveToDrive(b)}>Save to Drive &amp; register</button>}
              {b.status === "saved" && b.resumes && (
                <> <span className="resume-chip">{b.resumes.uid}</span>{b.resumes.drive_url && <> <a href={b.resumes.drive_url} target="_blank" rel="noreferrer">Drive ↗</a></>}</>
              )}
              {b.status === "failed" && b.error && <pre className="build-error">{b.error}</pre>}
            </li>
          ))}
        </ul>
      )}
      {toast && active && <div className="toast">{toast}</div>}
    </section>
  );
}

/** A field: plain text when it round-trips, else its LaTeX (links, bold …). */
function FieldBox({ f, value, rows, onChange, disabled }: {
  f: Field; value: string | undefined; rows: number; onChange: (v: string) => void; disabled?: boolean;
}) {
  return (
    <textarea className={f.simple ? "" : "mono"} rows={rows} value={value ?? f.plain} disabled={disabled}
              title={f.simple ? undefined : "Contains LaTeX (links, formatting): edit it as LaTeX"}
              onChange={(e) => onChange(e.target.value)} />
  );
}

function EntryBox({ e, on, projects, draft, set }: {
  e: Entry; on: boolean; projects: boolean; draft: Draft; set: (f: (d: Draft) => Draft) => void;
}) {
  const head = [e.args[0], e.args[2], e.args[1]].map((f) => f.plain.replace(/\\href\{[^}]*\}\{([^}]*)\}/g, "$1")).filter(Boolean).join(" · ");
  const extra = draft.extra[e.id] ?? [];
  return (
    <div className={`cv-entry${on ? "" : " off"}`}>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(x) => set((d) => { d.on[e.id] = x.target.checked; return d; })}
               title={projects ? "Projects are included when one of their bullets is ticked" : "Include this entry"} />
        <strong>{head}</strong>
      </label>
      {e.bullets.map((b) => {
        const ticked = !!draft.on[b.id];
        return (
          <div key={b.id} className={`cv-bullet${ticked ? "" : " off"}`}>
            <input type="checkbox" checked={ticked} aria-label="Use this bullet"
                   onChange={(x) => set((d) => { d.on[b.id] = x.target.checked; return d; })} />
            {ticked
              ? <FieldBox f={b.field} value={draft.text[b.id]} rows={2} onChange={(v) => set((d) => { d.text[b.id] = v; return d; })} />
              : <span className="cv-bullet-text">{b.field.plain}</span>}
          </div>
        );
      })}
      {extra.map((t, i) => (
        <div key={i} className="cv-bullet">
          <button className="link danger" aria-label="Remove this bullet"
                  onClick={() => set((d) => { d.extra[e.id] = extra.filter((_, j) => j !== i); return d; })}>×</button>
          <textarea rows={2} value={t} placeholder="A bullet for this job only"
                    onChange={(x) => set((d) => { d.extra[e.id] = extra.map((y, j) => (j === i ? x.target.value : y)); return d; })} />
        </div>
      ))}
      <button className="link small" onClick={() => set((d) => { d.extra[e.id] = [...extra, ""]; return d; })}>+ Add a bullet for this job</button>
    </div>
  );
}
