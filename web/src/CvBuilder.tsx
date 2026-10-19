import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adLanguage } from "./contactfinder";
import {
  detectFormat, indexMaster, initialDraft, markToPlain, plainText, renderTex,
  type CvDraft, type CvFormat, type Master, type SkillGroup,
} from "./cvformat";
import { type Item, type Lang } from "./cvschema";
import { applyTick, buildPlan, parseCvText, tickIndex, type PlanSection, type TextDraft, type Tick } from "./cvtext";
import { cvFileName } from "./cvtex";
import { BASE_COLUMNS, loadItems, type BaseCv } from "./MasterCv";
import { useSkills } from "./skills-data";
import { supabase } from "./supabase";

// CV generator on a job's page (owner decisions 2026-10-14 and 2026-10-19): pick a format, tick records and
// bullets from the master CV on the left; their text goes into one big text box on the right, at its place
// (unticking takes it out again while unchanged). The box is edited freely and, on compile, split back into
// sections, entries, bullets and rows by its markers (cvtext.ts). The draft is saved with the job and never
// written back to the master. Then compile to PDF, download it or save it to Drive as a resume version.

type Build = {
  id: string; status: "queued" | "compiling" | "compiled" | "failed" | "saved"; pages: number | null;
  error: string | null; file_name: string; pdf_path: string | null; created_at: string;
  resume_id: string | null; resumes?: { uid: string; drive_url: string | null } | null;
};
const BUILD_COLUMNS = "id,status,pages,error,file_name,pdf_path,created_at,resume_id,resumes(uid,drive_url)";

type Job = { id: string; title: string; company_name: string; description: string | null;
             must_have_skills: string[] | null; nice_to_have_skills: string[] | null };

/** A CV made whenever needed, without a job (owner request 2026-10-19): one saved draft with a name. */
export type AdHoc = { id: string; name: string; base_cv_id: string | null };

export default function CvBuilder({ job, adhoc, active }: { job?: Job; adhoc?: AdHoc; active: boolean }) {
  const [bases, setBases] = useState<BaseCv[] | null>(null);
  const [baseId, setBaseId] = useState("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [draft, setDraft] = useState<TextDraft | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">("saved");
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
        // A job's CV starts in the ad's language; an ad-hoc CV in the format it was last made with.
        const lang = job ? adLanguage(job.description) : null;
        const saved = adhoc?.base_cv_id && list.some((b) => b.id === adhoc.base_cv_id) ? adhoc.base_cv_id : null;
        setBaseId((cur) => cur || saved || (list.find((b) => b.lang === lang) ?? list[0])?.id || "");
      });
    loadItems().then(setItems, (e) => setError(e.message));
  }, [job?.description, adhoc?.base_cv_id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const base = bases?.find((b) => b.id === baseId) ?? null;
  const fmt = useMemo<{ f: CvFormat | null; error: string | null }>(() => {
    if (!base) return { f: null, error: null };
    try { return { f: detectFormat(base.tex_source, base.lang), error: null }; } catch (e) { return { f: null, error: e instanceof Error ? e.message : "Can't read it." }; }
  }, [base]);
  const f = fmt.f;
  const lang: Lang = base?.lang ?? "de";
  const m = useMemo(() => (items ? indexMaster(items) : null), [items]);

  // Skills: your skills (rated 3+, or unrated from the profile) per category; pre-ticked when the job asks
  // for them or you're strong (6+). Category labels per language come from the Skills page.
  const asked = useMemo(() => {
    const ids = new Set<string>();
    for (const raw of [...(job?.must_have_skills ?? []), ...(job?.nice_to_have_skills ?? [])]) {
      const x = sk.index?.match(raw);
      if (x) sk.index!.lineage(x).forEach((y) => ids.add(y.id));
    }
    return ids;
  }, [sk.index, job?.must_have_skills, job?.nice_to_have_skills]);
  const skillGroups = useMemo<SkillGroup[]>(() => {
    const mine = (sk.catalog ?? []).filter((x) => sk.isMine(x));
    const by = new Map<string, typeof mine>();
    for (const x of mine) by.set(x.category ?? "other", [...(by.get(x.category ?? "other") ?? []), x]);
    return [...by.entries()].map(([cat, list]) => {
      const c = sk.categories.find((k) => k.category === cat);
      const label = (lang === "de" ? c?.label_de : c?.label_en) ?? cat.replace(/_/g, " ").replace(/^./, (s) => s.toUpperCase());
      const items = list.map((x) => ({ x, asked: asked.has(x.id), rating: sk.ratingOf(x.id) }))
        .sort((a, b) => Number(b.asked) - Number(a.asked) || (b.rating ?? 0) - (a.rating ?? 0) || a.x.name.localeCompare(b.x.name))
        .map((i) => ({ id: i.x.id, name: i.x.name, on: i.asked || (i.rating ?? 0) >= 6, asked: i.asked }));
      return { cat, label, items, order: c?.cv_order ?? 100 };
    }).sort((a, b) => a.order - b.order || a.cat.localeCompare(b.cat));
  }, [sk.catalog, sk.categories, sk.isMine, sk.ratingOf, asked, lang]);

  const newDraft = useCallback((): TextDraft | null =>
    (f && m ? { v: 2, header: initialDraft(f, m, []).header, text: "", ticked: [] } : null), [f, m]);

  // The draft: a job's is saved per job and format; an ad-hoc CV is one draft whatever the format (switching
  // the format only changes the layout). A new one starts with the header and an empty text.
  const loadedFor = useRef("");
  useEffect(() => {
    if (!f || !m || !base || !sk.catalog) return;
    const key = adhoc ? adhoc.id : `${job!.id}.${base.id}`;
    if (loadedFor.current === key) {
      if (adhoc) setSaveState("dirty");       // the format changed: remember it with the draft
      return;
    }
    loadedFor.current = key;
    const q = supabase.from("cv_drafts").select("data");
    (adhoc ? q.eq("id", adhoc.id) : q.eq("job_posting_id", job!.id).eq("base_cv_id", base.id)).maybeSingle()
      .then(({ data }) => {
        const saved = (data as { data: TextDraft } | null)?.data;
        setDraft(saved?.v === 2 ? saved : newDraft());
        setSaveState("saved");
      });
  }, [f, m, base, job, adhoc, sk.catalog, newDraft]);

  // Autosave, a moment after the last change.
  useEffect(() => {
    if (!draft || saveState !== "dirty" || !base) return;
    const t = setTimeout(async () => {
      setSaveState("saving");
      const { error } = adhoc
        ? await supabase.from("cv_drafts").update({ base_cv_id: base.id, data: draft }).eq("id", adhoc.id)
        : await supabase.from("cv_drafts")
          .upsert({ job_posting_id: job!.id, base_cv_id: base.id, data: draft }, { onConflict: "job_posting_id,base_cv_id" });
      if (error) setError(error.message);
      setSaveState(error ? "dirty" : "saved");
    }, 1200);
    return () => clearTimeout(t);
  }, [draft, saveState, base, job, adhoc]);

  const change = useCallback((fn: (d: TextDraft) => void) => {
    setDraft((d) => { if (!d) return d; const n = structuredClone(d); fn(n); return n; });
    setSaveState("dirty");
  }, []);

  const plan = useMemo(() => (f && m ? buildPlan(f, m, skillGroups) : []), [f, m, skillGroups]);
  const ticks = useMemo(() => tickIndex(plan), [plan]);
  function tick(t: Tick, on: boolean) {
    if (!draft) return;
    const r = applyTick(draft, t, on, plan);
    change((d) => { d.text = r.text; d.ticked = r.ticked; });
    if (r.note) flash(r.note);
  }
  /** The job's skills and your strong ones (6+), ticked in one go. */
  function tickSuggested() {
    if (!draft) return;
    let d = draft;
    for (const g of skillGroups) for (const it of g.items) {
      const t = ticks.get(`k:${it.id}`);
      if (it.on && t && !d.ticked.includes(t.key)) { const r = applyTick(d, t, true, plan); d = { ...d, text: r.text, ticked: r.ticked }; }
    }
    change((x) => { x.text = d.text; x.ticked = d.ticked; });
  }

  const parsed = useMemo(() => (f && draft ? parseCvText(draft.text, f, lang) : null), [f, draft, lang]);
  const cvDraft = useMemo<CvDraft | null>(() => (draft && parsed ? { v: 1, header: draft.header, sections: parsed.sections } : null), [draft, parsed]);

  const loadBuilds = useCallback(async () => {
    const q = supabase.from("cv_builds").select(BUILD_COLUMNS);
    const { data } = await (adhoc ? q.eq("cv_draft_id", adhoc.id) : q.eq("job_posting_id", job!.id))
      .order("created_at", { ascending: false }).limit(5);
    setBuilds((data ?? []) as unknown as Build[]);
  }, [job, adhoc]);
  useEffect(() => { loadBuilds(); }, [loadBuilds]);
  const pending = builds.some((b) => b.status === "queued" || b.status === "compiling");
  useEffect(() => {
    if (!pending || !active) return;
    const t = setInterval(loadBuilds, 4000);
    return () => clearInterval(t);
  }, [pending, active, loadBuilds]);

  const tex = useMemo(() => (f && cvDraft ? renderTex(f, cvDraft) : ""), [f, cvDraft]);
  const plain = useMemo(() => (cvDraft ? plainText(cvDraft) : ""), [cvDraft]);
  // An ad-hoc CV is named for the company typed in (if any): CV_Name_Company.pdf, else CV_Name.pdf.
  const fileName = cvFileName(lang, draft?.header.name ?? null, job ? job.company_name : draft?.company ?? "");
  const keywords = useMemo(() => {
    const t = plain.toLowerCase();
    return [...(job?.must_have_skills ?? []).map((s) => ({ s, must: true })), ...(job?.nice_to_have_skills ?? []).map((s) => ({ s, must: false }))]
      .map((k) => ({ ...k, hit: t.includes(k.s.toLowerCase()) }));
  }, [plain, job?.must_have_skills, job?.nice_to_have_skills]);

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };
  async function copyTex() {
    try { await navigator.clipboard.writeText(tex); flash("LaTeX copied: paste it into Overleaf"); } catch { flash("Couldn't copy"); }
  }
  function downloadTex() {
    const url = URL.createObjectURL(new Blob([tex], { type: "application/x-tex" }));
    Object.assign(document.createElement("a"), { href: url, download: fileName.replace(/\.pdf$/, ".tex") }).click();
    URL.revokeObjectURL(url);
  }
  async function compile() {
    if (!f || !base) return;
    setBusy(true);
    const { data, error } = await supabase.from("cv_builds").insert({
      job_posting_id: job?.id ?? null, cv_draft_id: adhoc?.id ?? null, base_cv_id: base.id, lang, tex_source: tex, plain_text: plain, file_name: fileName,
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
    const { data, error } = await supabase.functions.invoke("cv-save", { body: { build_id: b.id, label: (job ? `${job.company_name} – ${job.title}` : [adhoc?.name, draft?.company].filter(Boolean).join(" – ")).slice(0, 120) } });
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
    return <p className="muted">No CV format yet. Upload your LaTeX CV under <a href="#mastercv">Me → Master CV</a> → CV formats: its layout is used, the content comes from the master CV.</p>;
  }
  if (!bases || !base || !items) return <p className="muted">{error ?? "Loading…"}</p>;

  return (
    <section className="cv-builder">
      <div className="notepad-head">
        <h2>CV</h2>
        <select value={baseId} onChange={(e) => setBaseId(e.target.value)} aria-label="Format">
          {bases.map((b) => <option key={b.id} value={b.id}>{b.lang.toUpperCase()} format v{b.version}{b.label ? ` · ${b.label}` : ""}</option>)}
        </select>
        <span className="muted small">{saveState === "saved" ? "Draft saved" : saveState === "saving" ? "Saving…" : "Unsaved"}</span>
        <button className="link" onClick={() => {
          if (!window.confirm("Start over? The text and ticks for this job are cleared.")) return;
          setDraft(newDraft()); setSaveState("dirty");
        }}>Reset</button>
      </div>
      {error && <p className="notice">{error} <button className="link" onClick={() => setError(null)}>×</button></p>}
      {fmt.error && <p className="notice">This format can't be read: {fmt.error}</p>}
      {items.length === 0 && <p className="notice">The master CV is empty. Fill it on <a href="#mastercv">Me → Master CV</a> (or import your CV there).</p>}

      {keywords.length > 0 && (
        <div className="keywords">
          <span className="muted small">Job's skills in your CV:</span>
          {keywords.map((k) => (
            <span key={`${k.must}-${k.s}`} className={`skill ${k.hit ? "hit" : k.must ? "miss" : "plain"}`} title={k.must ? "Must-have" : "Nice to have"}>
              {k.hit ? "✓ " : ""}{k.s}{(() => { const x = sk.index?.match(k.s); const r = x ? sk.ratingOf(x.id) : null; return r == null ? "" : ` · ${r}/10`; })()}
            </span>
          ))}
          <span className="muted small">{keywords.filter((k) => k.must && k.hit).length}/{keywords.filter((k) => k.must).length} must-haves</span>
        </div>
      )}

      {draft && f && m && parsed && (
        <>
          <HeaderBox draft={draft} change={change} adhoc={!!adhoc} />
          <div className="cv-split">
            <Picks plan={plan} m={m} ticked={draft.ticked} onTick={tick} onSuggested={tickSuggested} hasJob={!!job} />
            <div className="cv-editor">
              <textarea className="cv-text" value={draft.text} spellCheck
                        placeholder={"Tick on the left, or write here:\n\n# Profil\nText …\n\n# Berufserfahrung\n## Company | 11/2023 – 06/2024\nRole | City\n- A bullet"}
                        onChange={(e) => change((d) => { d.text = e.target.value; })} />
              <div className="cv-outline small">
                <span className="muted">Will be written as:</span>{" "}
                {parsed.outline.length ? parsed.outline.join(" · ") : <span className="muted">nothing yet</span>}
                {parsed.problems.map((p, i) => <div key={i} className="notice-inline">{p}</div>)}
              </div>
              <details className="cv-help small">
                <summary>Text format</summary>
                <code># Section</code> a section · <code>## Left | Right</code> an entry heading, the next line <code>Left | Right</code> its second line ·{" "}
                <code>&gt; text</code> its grey context line · <code>- text</code> a bullet · <code>Label: text</code> a row ·{" "}
                <code>[text](https://…)</code> a link · <code>**text**</code> bold. Empty sections are left out.
              </details>
            </div>
          </div>
        </>
      )}

      <div className="prompt-row">
        <button className="primary small" disabled={!draft || busy || !draft.text.trim()} onClick={compile} title="Compiles in GitHub Actions, about a minute">Compile PDF</button>
        <button className="small" disabled={!draft} onClick={copyTex}>Copy LaTeX</button>
        <button className="small" disabled={!draft} onClick={downloadTex}>Download .tex</button>
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

type Change = (fn: (d: TextDraft) => void) => void;

function HeaderBox({ draft, change, adhoc }: { draft: TextDraft; change: Change; adhoc: boolean }) {
  const h = draft.header;
  return (
    <div className="cv-section">
      {adhoc && (
        <label className="cv-field cv-company"><span>For company (optional: names the PDF file)</span>
          <input value={draft.company ?? ""} placeholder="e.g. Beispiel AG" onChange={(e) => change((d) => { d.company = e.target.value; })} /></label>
      )}
      <div className="cv-slots three">
        <label className="cv-field"><span>Name</span><input value={h.name} onChange={(e) => change((d) => { d.header.name = e.target.value; })} /></label>
        <label className="cv-field"><span>Headline</span><input value={h.headline} placeholder="optional" onChange={(e) => change((d) => { d.header.headline = e.target.value; })} /></label>
        <label className="cv-field"><span>Location</span><input value={h.location} onChange={(e) => change((d) => { d.header.location = e.target.value; })} /></label>
      </div>
      <div className="cv-contacts">
        {h.contacts.map((c, i) => (
          <label key={i} className={`tick${c.on ? " on" : ""}`}>
            <input type="checkbox" checked={c.on} onChange={(e) => change((d) => { d.header.contacts[i].on = e.target.checked; })} />
            <input className="inline-input" size={Math.max(6, c.text.length)} value={c.text} onChange={(e) => change((d) => { d.header.contacts[i].text = e.target.value; })} />
          </label>
        ))}
      </div>
    </div>
  );
}

/** The left pane: sections, their records and bullets to tick. */
function Picks({ plan, m, ticked, onTick, onSuggested, hasJob }: {
  plan: PlanSection[]; m: Master; ticked: string[]; onTick: (t: Tick, on: boolean) => void; onSuggested: () => void; hasJob: boolean;
}) {
  const on = (key: string) => ticked.includes(key);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <div className="cv-picks">
      {plan.map((s) => {
        const count = s.groups.reduce((n, g) => n + g.ticks.length, 0);
        const used = s.groups.reduce((n, g) => n + g.ticks.filter((t) => on(t.key)).length, 0);
        const isOpen = open[s.key] ?? used > 0;
        return (
          <div key={s.key} className="cv-pick-section">
            <div className="cv-pick-head">
              <input type="checkbox" checked={on(`sec:${s.key}`) || used > 0} aria-label={`Section ${s.title}`}
                     onChange={(e) => onTick({ kind: "section", key: `sec:${s.key}`, section: s.key }, e.target.checked)} />
              <button className="link cv-pick-title" onClick={() => setOpen((o) => ({ ...o, [s.key]: !isOpen }))}>
                {isOpen ? "▾" : "▸"} {s.title} <span className="muted small">{count ? `${used}/${count}` : ""}</span>
              </button>
            </div>
            {isOpen && (
              <div className="cv-pick-body">
                {s.key === "skills" && <button className="link small" onClick={onSuggested}>{hasJob ? "Tick the job's skills and your strong ones (6+)" : "Tick your strong skills (6+)"}</button>}
                {count === 0 && s.key !== "skills" && <p className="muted small">Nothing in the master CV: write it in the box.</p>}
                {s.groups.map((g, gi) => (
                  <div key={gi} className="cv-pick-group">
                    {g.title && <div className="muted small">{g.title}{g.note ? ` (${g.note})` : ""}</div>}
                    {g.ticks.map((t) => (
                      <div key={t.key}>
                        <label className={`cv-tick${on(t.key) ? " on" : ""}`}>
                          <input type="checkbox" checked={on(t.key)} onChange={(e) => onTick(t, e.target.checked)} />
                          <span className={t.kind === "entry" ? "strong" : ""}>{markToPlain(t.label)}</span>
                        </label>
                        {t.children && t.children.length > 0 && (on(t.key) || t.children.some((c) => on(c.key))) && (
                          <div className="cv-pick-children">
                            {t.children.map((c) => (
                              <label key={c.key} className={`cv-tick${on(c.key) ? " on" : ""}`}>
                                <input type="checkbox" checked={on(c.key)} onChange={(e) => onTick(c, e.target.checked)} />
                                <span>{markToPlain(c.label)}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {m.items.length === 0 && <p className="muted small">The master CV is empty.</p>}
    </div>
  );
}

