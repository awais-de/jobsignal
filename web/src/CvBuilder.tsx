import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adLanguage } from "./contactfinder";
import {
  appendPart, bulletText, markToPlain, detectFormat, entrySources, indexMaster, initialDraft, newEntry, plainText, reconcile, removePart, renderTex,
  type CvDraft, type CvFormat, type DEntry, type DSection, type Master, type SkillGroup,
} from "./cvformat";
import { coursesPrefix, itemLabel, joinText, rowOf, sectionSpec, tr, type Item, type Lang } from "./cvschema";
import { cvFileName } from "./cvtex";
import { BASE_COLUMNS, loadItems, type BaseCv } from "./MasterCv";
import { useSkills } from "./skills-data";
import { supabase } from "./supabase";

// CV generator on a job's page (owner decision 2026-10-14): pick a format, then tick sections, records and
// bullets from the master CV. Ticking copies the text into an editable box (unticking removes it again);
// every box is free text for this CV. The draft is saved with the job and never written back to the master.
// Then compile to PDF, download it or save it to Drive as a registered resume version.

type Build = {
  id: string; status: "queued" | "compiling" | "compiled" | "failed" | "saved"; pages: number | null;
  error: string | null; file_name: string; pdf_path: string | null; created_at: string;
  resume_id: string | null; resumes?: { uid: string; drive_url: string | null } | null;
};
const BUILD_COLUMNS = "id,status,pages,error,file_name,pdf_path,created_at,resume_id,resumes(uid,drive_url)";

type Job = { id: string; title: string; company_name: string; description: string | null;
             must_have_skills: string[] | null; nice_to_have_skills: string[] | null };

export default function CvBuilder({ job, active }: { job: Job; active: boolean }) {
  const [bases, setBases] = useState<BaseCv[] | null>(null);
  const [baseId, setBaseId] = useState("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [draft, setDraft] = useState<CvDraft | null>(null);
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
        const lang = adLanguage(job.description);
        setBaseId((cur) => cur || (list.find((b) => b.lang === lang) ?? list[0])?.id || "");
      });
    loadItems().then(setItems, (e) => setError(e.message));
  }, [job.description]);

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
    for (const raw of [...(job.must_have_skills ?? []), ...(job.nice_to_have_skills ?? [])]) {
      const x = sk.index?.match(raw);
      if (x) sk.index!.lineage(x).forEach((y) => ids.add(y.id));
    }
    return ids;
  }, [sk.index, job.must_have_skills, job.nice_to_have_skills]);
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

  // The draft: saved per job and format; the first one is made from the format and the master.
  const loadedFor = useRef("");
  useEffect(() => {
    if (!f || !m || !base || !sk.catalog) return;
    const key = `${job.id}.${base.id}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    supabase.from("cv_drafts").select("data").eq("job_posting_id", job.id).eq("base_cv_id", base.id).maybeSingle()
      .then(({ data }) => {
        const saved = (data as { data: CvDraft } | null)?.data;
        setDraft(saved?.v === 1 ? reconcile(saved, f, m) : initialDraft(f, m, skillGroups));
        setSaveState("saved");
      });
  }, [f, m, base, job.id, sk.catalog, skillGroups]);

  // Autosave, a moment after the last change.
  useEffect(() => {
    if (!draft || saveState !== "dirty" || !base) return;
    const t = setTimeout(async () => {
      setSaveState("saving");
      const { error } = await supabase.from("cv_drafts")
        .upsert({ job_posting_id: job.id, base_cv_id: base.id, data: draft }, { onConflict: "job_posting_id,base_cv_id" });
      if (error) setError(error.message);
      setSaveState(error ? "dirty" : "saved");
    }, 1200);
    return () => clearTimeout(t);
  }, [draft, saveState, base, job.id]);

  const change = useCallback((fn: (d: CvDraft) => void) => {
    setDraft((d) => { if (!d) return d; const n = structuredClone(d); fn(n); return n; });
    setSaveState("dirty");
  }, []);

  const loadBuilds = useCallback(async () => {
    const { data } = await supabase.from("cv_builds").select(BUILD_COLUMNS).eq("job_posting_id", job.id)
      .order("created_at", { ascending: false }).limit(5);
    setBuilds((data ?? []) as unknown as Build[]);
  }, [job.id]);
  useEffect(() => { loadBuilds(); }, [loadBuilds]);
  const pending = builds.some((b) => b.status === "queued" || b.status === "compiling");
  useEffect(() => {
    if (!pending || !active) return;
    const t = setInterval(loadBuilds, 4000);
    return () => clearInterval(t);
  }, [pending, active, loadBuilds]);

  const tex = useMemo(() => (f && draft ? renderTex(f, draft) : ""), [f, draft]);
  const plain = useMemo(() => (draft ? plainText(draft) : ""), [draft]);
  const fileName = cvFileName(lang, draft?.header.name ?? null, job.company_name);
  const keywords = useMemo(() => {
    const t = plain.toLowerCase();
    return [...(job.must_have_skills ?? []).map((s) => ({ s, must: true })), ...(job.nice_to_have_skills ?? []).map((s) => ({ s, must: false }))]
      .map((k) => ({ ...k, hit: t.includes(k.s.toLowerCase()) }));
  }, [plain, job.must_have_skills, job.nice_to_have_skills]);

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
      job_posting_id: job.id, base_cv_id: base.id, lang, tex_source: tex, plain_text: plain, file_name: fileName,
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
          if (!f || !m || !window.confirm("Start over from the master CV? Your ticks and edits for this job are cleared.")) return;
          setDraft(initialDraft(f, m, skillGroups)); setSaveState("dirty");
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

      {draft && f && m && (
        <>
          <HeaderBox draft={draft} change={change} />
          {draft.sections.map((s, i) => (
            <SectionBox key={s.key} s={s} i={i} draft={draft} f={f} m={m} lang={lang} skills={skillGroups} change={change} />
          ))}
        </>
      )}

      <div className="prompt-row">
        <button className="primary small" disabled={!draft || busy} onClick={compile} title="Compiles in GitHub Actions, about a minute">Compile PDF</button>
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

type Change = (fn: (d: CvDraft) => void) => void;
const sec = (d: CvDraft, key: string) => d.sections.find((s) => s.key === key)!;
function moveIn<T>(list: T[], i: number, dir: -1 | 1) {
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

function HeaderBox({ draft, change }: { draft: CvDraft; change: Change }) {
  const h = draft.header;
  return (
    <div className="cv-section">
      <h3>Header</h3>
      <div className="cv-slots">
        <label className="cv-field"><span>Name</span><input value={h.name} onChange={(e) => change((d) => { d.header.name = e.target.value; })} /></label>
        <label className="cv-field"><span>Headline</span><input value={h.headline} onChange={(e) => change((d) => { d.header.headline = e.target.value; })} /></label>
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

function SectionBox({ s, i, draft, f, m, lang, skills, change }: {
  s: DSection; i: number; draft: CvDraft; f: CvFormat; m: Master; lang: Lang; skills: SkillGroup[]; change: Change;
}) {
  const spec = sectionSpec(s.key);
  if (!spec) return null;
  const sources = s.key === "skills" ? [] : m.roots(s.key);
  // Rows sections that are on: where a joinable section can be written as one row.
  const targets = draft.sections.filter((x) => x.style === "rows" && x.on && x.key !== s.key && !x.into);
  const upd = (fn: (x: DSection, d: CvDraft) => void) => change((d) => fn(sec(d, s.key), d));

  function place(into: string | null) {
    change((d) => {
      const x = sec(d, s.key);
      if (x.into) { const t = sec(d, x.into); t.rows = t.rows.filter((r) => r.src !== `section:${s.key}`); }
      x.into = into;
      if (into) {
        const t = sec(d, into);
        t.rows.push({ src: `section:${s.key}`, label: x.title, text: x.picked.map((id) => m.byId.get(id)).filter(Boolean).map((it) => joinText(it!, lang)).join(", ") });
      }
    });
  }
  /** Joined mode: ticking appends the record to the target row's text; unticking takes it out. */
  function pickJoined(it: Item, on: boolean) {
    change((d) => {
      const x = sec(d, s.key);
      const t = sec(d, x.into!);
      let row = t.rows.find((r) => r.src === `section:${s.key}`);
      if (!row) { row = { src: `section:${s.key}`, label: x.title, text: "" }; t.rows.push(row); }
      const part = joinText(it, lang);
      x.picked = on ? [...x.picked, it.id] : x.picked.filter((p) => p !== it.id);
      row.text = on ? appendPart(row.text, part) : removePart(row.text, part);
    });
  }

  return (
    <div className={`cv-section${s.on ? "" : " off"}`}>
      <div className="cv-section-head">
        <input type="checkbox" checked={s.on} aria-label={`Include ${s.title}`} onChange={(e) => upd((x) => { x.on = e.target.checked; })} />
        <input className="cv-title-input" value={s.title} aria-label="Section title" onChange={(e) => upd((x, d) => {
          x.title = e.target.value;
          if (x.into) { const r = sec(d, x.into).rows.find((r) => r.src === `section:${s.key}`); if (r) r.label = e.target.value; }
        })} />
        <span className="muted small">{spec.title.en !== s.title ? spec.title.en : ""}</span>
        <span className="mcv-tools">
          {spec.joinable && s.on && (
            <select value={s.into ?? ""} onChange={(e) => place(e.target.value || null)} aria-label="Placement">
              <option value="">Own section</option>
              {targets.map((t) => <option key={t.key} value={t.key}>Row in {t.title}</option>)}
            </select>
          )}
          <button className="link" aria-label="Move up" onClick={() => change((d) => moveIn(d.sections, i, -1))}>↑</button>
          <button className="link" aria-label="Move down" onClick={() => change((d) => moveIn(d.sections, i, 1))}>↓</button>
        </span>
      </div>
      {s.on && s.into && (
        <div className="cv-body">
          <p className="muted small">Written as the row “{s.title}” in {sec(draft, s.into).title}: ticking adds to that row's text (edit it there).</p>
          <Ticks items={sources} on={(it) => s.picked.includes(it.id)} label={(it) => joinText(it, lang) || itemLabel(it)} onTick={pickJoined} />
        </div>
      )}
      {s.on && !s.into && (
        <div className="cv-body">
          {s.style === "text" && (
            <>
              {sources.length > 0 && (
                <div className="row small">
                  <span className="muted">Start from:</span>
                  {sources.map((it) => (
                    <button key={it.id} className="chip" onClick={() => {
                      const t = tr(it.data.text, lang);
                      if (s.text.trim() && !window.confirm("Replace the current text with this version?")) return;
                      upd((x) => { x.text = t; });
                    }}>{(it.data.label as string) || "version"}</button>
                  ))}
                </div>
              )}
              <textarea rows={4} value={s.text} placeholder={s.key === "summary" ? "Written for this job" : ""} onChange={(e) => upd((x) => { x.text = e.target.value; })} />
            </>
          )}
          {s.style === "bullets" && (
            <>
              {s.key === "highlights" && <p className="muted small">2–3 bullets answering this posting's top requirements with your evidence. Empty: left out.</p>}
              <Ticks items={sources} on={(it) => s.bullets.some((b) => b.src === it.id)}
                     label={(it) => bulletText(it, lang) || itemLabel(it)}
                     onTick={(it, on) => upd((x) => { x.bullets = on ? [...x.bullets, { src: it.id, text: bulletText(it, lang) }] : x.bullets.filter((b) => b.src !== it.id); })} />
              <BulletList bullets={s.bullets} set={(fn) => upd((x) => fn(x.bullets))} />
            </>
          )}
          {s.style === "entries" && (
            <>
              {s.entries.map((e, k) => (
                <EntryBox key={e.src ?? `custom-${k}`} e={e} k={k} f={f} m={m} lang={lang} slots={spec.slots ?? []} upd={upd} />
              ))}
              <button className="link small" onClick={() => upd((x) => { x.entries.push({ src: null, on: true, slots: ["", "", "", ""], context: "", bullets: [], picked: [] }); })}>
                + An entry for this CV only
              </button>
            </>
          )}
          {s.style === "rows" && <RowsBox s={s} lang={lang} skills={skills} sources={sources} draft={draft} upd={upd} />}
        </div>
      )}
    </div>
  );
}

function Ticks({ items, on, label, onTick }: { items: Item[]; on: (it: Item) => boolean; label: (it: Item) => string; onTick: (it: Item, on: boolean) => void }) {
  if (!items.length) return null;
  return (
    <div className="cv-ticks">
      {items.map((it) => (
        <label key={it.id} className={`cv-tick${on(it) ? " on" : ""}`}>
          <input type="checkbox" checked={on(it)} onChange={(e) => onTick(it, e.target.checked)} />
          <span>{markToPlain(label(it))}</span>
        </label>
      ))}
    </div>
  );
}

function BulletList({ bullets, set }: { bullets: { src?: string; text: string }[]; set: (fn: (b: { src?: string; text: string }[]) => void) => void }) {
  return (
    <div className="cv-bullets">
      {bullets.map((b, i) => (
        <div key={i} className="cv-bullet">
          <span className="cv-dot">•</span>
          <textarea rows={2} value={b.text} onChange={(e) => set((l) => { l[i].text = e.target.value; })} />
          <span className="cv-bullet-tools">
            <button className="link" aria-label="Move up" onClick={() => set((l) => moveIn(l, i, -1))}>↑</button>
            <button className="link" aria-label="Move down" onClick={() => set((l) => moveIn(l, i, 1))}>↓</button>
            <button className="link danger" aria-label="Remove" onClick={() => set((l) => { l.splice(i, 1); })}>×</button>
          </span>
        </div>
      ))}
      <button className="link small" onClick={() => set((l) => { l.push({ text: "" }); })}>+ Bullet</button>
    </div>
  );
}

function EntryBox({ e, k, f, m, lang, slots, upd }: {
  e: DEntry; k: number; f: CvFormat; m: Master; lang: Lang; slots: string[];
  upd: (fn: (x: DSection, d: CvDraft) => void) => void;
}) {
  const it = e.src ? m.byId.get(e.src) : undefined;
  const parent = it?.parent_id ? m.byId.get(it.parent_id) : undefined;
  const name = it ? itemLabel(it, parent) : (e.slots.filter(Boolean).join(" · ") || "Entry for this CV");
  const sources = entrySources(e, m);
  const setE = (fn: (x: DEntry) => void) => upd((x) => fn(x.entries[k]));

  function tick(src: Item, on: boolean) {
    setE((x) => {
      if (src.kind === "course") {
        // Courses go into one bullet: "Relevante Kurse: A, B".
        const pre = coursesPrefix(lang);
        let b = x.bullets.find((y) => y.src === "courses");
        const name = bulletText(src, lang);
        x.picked = on ? [...x.picked, src.id] : x.picked.filter((p) => p !== src.id);
        if (on) {
          if (!b) { b = { src: "courses", text: pre + name }; x.bullets.push(b); } else b.text = appendPart(b.text, name);
        } else if (b) {
          b.text = b.text.startsWith(pre) ? pre + removePart(b.text.slice(pre.length), name) : removePart(b.text, name);
          if (b.text.trim() === pre.trim() || !b.text.trim()) x.bullets = x.bullets.filter((y) => y !== b);
        }
        return;
      }
      x.bullets = on ? [...x.bullets, { src: src.id, text: bulletText(src, lang) }] : x.bullets.filter((y) => y.src !== src.id);
    });
  }
  const ticked = (src: Item) => (src.kind === "course" ? e.picked.includes(src.id) : e.bullets.some((b) => b.src === src.id));

  return (
    <div className={`cv-entry${e.on ? "" : " off"}`}>
      <div className="cv-entry-head">
        <label className="check">
          <input type="checkbox" checked={e.on} onChange={(x) => setE((y) => { y.on = x.target.checked; })} />
          <strong>{name}</strong>
        </label>
        <span className="mcv-tools">
          {it && e.on && (
            <button className="link small" title="Fill the heading again from the master CV" onClick={() => {
              const fresh = newEntry(it, m, f, true);
              setE((y) => { y.slots = fresh.slots; y.context = fresh.context; });
            }}>↺ heading</button>
          )}
          <button className="link" aria-label="Move up" onClick={() => upd((x) => moveIn(x.entries, k, -1))}>↑</button>
          <button className="link" aria-label="Move down" onClick={() => upd((x) => moveIn(x.entries, k, 1))}>↓</button>
          {!it && <button className="link danger" aria-label="Remove" onClick={() => upd((x) => { x.entries.splice(k, 1); })}>×</button>}
        </span>
      </div>
      {e.on && (
        <>
          <div className="cv-slots">
            {[0, 1, 2, 3].map((n) => (
              <label key={n} className="cv-field"><span>{slots[n] ?? `Field ${n + 1}`}</span>
                <input value={e.slots[n] ?? ""} onChange={(x) => setE((y) => { y.slots[n] = x.target.value; })} /></label>
            ))}
            {f.styles.context && (
              <label className="cv-field wide"><span>Context line</span>
                <input value={e.context} placeholder="optional" onChange={(x) => setE((y) => { y.context = x.target.value; })} /></label>
            )}
          </div>
          <Ticks items={sources} on={ticked}
                 label={(src) => `${src.kind === "achievement" ? "🏆 " : src.kind === "course" ? "Course: " : ""}${bulletText(src, lang) || itemLabel(src)}`}
                 onTick={tick} />
          <BulletList bullets={e.bullets} set={(fn) => setE((y) => fn(y.bullets))} />
        </>
      )}
    </div>
  );
}

function RowsBox({ s, lang, skills, sources, draft, upd }: {
  s: DSection; lang: Lang; skills: SkillGroup[]; sources: Item[]; draft: CvDraft;
  upd: (fn: (x: DSection, d: CvDraft) => void) => void;
}) {
  return (
    <>
      {s.key !== "skills" && (
        <Ticks items={sources} on={(it) => s.rows.some((r) => r.src === `item:${it.id}`)}
               label={(it) => { const r = rowOf(it, lang); return [r.label, r.text].filter(Boolean).join(": ") || itemLabel(it); }}
               onTick={(it, on) => upd((x) => { x.rows = on ? [...x.rows, { src: `item:${it.id}`, ...rowOf(it, lang) }] : x.rows.filter((r) => r.src !== `item:${it.id}`); })} />
      )}
      <div className="cv-rows">
        {s.rows.map((r, i) => {
          const placed = r.src.startsWith("section:") ? draft.sections.find((x) => x.key === r.src.slice(8)) : undefined;
          if (placed && (!placed.on || placed.into !== s.key)) return null;
          const group = r.src.startsWith("skills:") ? skills.find((g) => `skills:${g.cat}` === r.src) : undefined;
          return (
            <div key={`${r.src}-${i}`} className="cv-rowedit">
              <div className="cv-rowedit-line">
                <input className="cv-row-label" value={r.label} placeholder="Label" onChange={(e) => upd((x) => { x.rows[i].label = e.target.value; })} />
                <textarea rows={2} value={r.text} onChange={(e) => upd((x) => { x.rows[i].text = e.target.value; })} />
                <span className="cv-bullet-tools">
                  <button className="link" aria-label="Move up" onClick={() => upd((x) => moveIn(x.rows, i, -1))}>↑</button>
                  <button className="link" aria-label="Move down" onClick={() => upd((x) => moveIn(x.rows, i, 1))}>↓</button>
                  {!placed && <button className="link danger" aria-label="Remove" onClick={() => upd((x) => { x.rows.splice(i, 1); })}>×</button>}
                </span>
              </div>
              {placed && <span className="muted small">from {placed.title}: tick its records in that section</span>}
              {group && (
                <div className="skill-ticks">
                  {group.items.map((it) => {
                    const on = s.picked.includes(it.id);
                    return (
                      <label key={it.id} className={`tick${on ? " on" : ""}${it.asked ? " asked" : ""}`}>
                        <input type="checkbox" checked={on} onChange={(e) => upd((x) => {
                          x.picked = e.target.checked ? [...x.picked, it.id] : x.picked.filter((p) => p !== it.id);
                          x.rows[i].text = e.target.checked ? appendPart(x.rows[i].text, it.name) : removePart(x.rows[i].text, it.name);
                        })} />
                        {it.name}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {s.key === "skills" && skills.filter((g) => !s.rows.some((r) => r.src === `skills:${g.cat}`)).map((g) => (
        <button key={g.cat} className="link small" onClick={() => upd((x) => { x.rows.push({ src: `skills:${g.cat}`, label: g.label, text: "" }); })}>+ {g.label}</button>
      ))}
      <button className="link small" onClick={() => upd((x) => { x.rows.push({ src: `custom:${Date.now()}`, label: "", text: "" }); })}>+ Row</button>
    </>
  );
}
