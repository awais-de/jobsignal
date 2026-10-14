import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtDate, label as skipLabel, Why } from "./Feed";
import { buildTailorPrompt, emptyNotes, NOTE_FIELDS, notesEqual, parseNotes, serializeNotes, type Notes } from "./notes";
import CvBuilder from "./CvBuilder";
import JobSkills from "./JobSkills";
import OutreachPanel from "./Outreach";
import { buildPrepPrompt } from "./prep";
import { RESUME_COLUMNS, type Resume } from "./Resumes";
import { POSTING_COLUMNS, SKIP_REASONS, sourceLabel, supabase, type Posting } from "./supabase";

// One job, opened as its own tab: the notepad next to everything known about the job.

type Job = Posting & { description: string | null; named_contact: string | null };
type Application = { id: string; applied_at: string | null; jd_snapshot: string | null; resume_id: string | null };

const REMOTE: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" };

export default function JobPage({ id, active, onLabel, onDirty }: {
  id: string;
  active: boolean;
  onLabel: (label: string) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [app, setApp] = useState<Application | null>(null);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Notes>(emptyNotes);
  const [draft, setDraft] = useState<Notes>(emptyNotes);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [cvId, setCvId] = useState<string>("");
  const [skipping, setSkipping] = useState(false);
  const [pane, setPane] = useState<"notes" | "cv">("notes");
  const [skillLines, setSkillLines] = useState<string>("");
  const [sender, setSender] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, a, r, prof] = await Promise.all([
      supabase.from("job_postings").select(POSTING_COLUMNS + ",description,named_contact").eq("id", id).maybeSingle(),
      supabase.from("applications").select("id,applied_at,jd_snapshot,resume_id")
        .eq("job_posting_id", id).is("deleted_at", null).maybeSingle(),
      supabase.from("resumes").select(RESUME_COLUMNS).is("deleted_at", null).order("created_at", { ascending: false }),
      supabase.from("owner_profile").select("profile").eq("id", 1).maybeSingle(),
    ]);
    setSender(((prof.data?.profile as { outreach?: { sender_name?: string } } | undefined)?.outreach?.sender_name ?? "").trim() || null);
    if (p.error || !p.data) return setError(p.error?.message ?? "This job doesn't exist or was deleted.");
    const j = p.data as unknown as Job;
    setJob(j);
    setApp((a.data as Application | null) ?? null);
    const rs = (r.data as Resume[] | null) ?? [];
    setResumes(rs);
    const n = parseNotes(j.notes);
    setSaved(n);
    setDraft(n);
    setCvId((cur) => cur || (a.data as Application | null)?.resume_id || rs.find((x) => x.extracted_text)?.id || "");
    onLabel(`${j.company_name} – ${j.title}`);
  }, [id, onLabel]);

  useEffect(() => { load(); }, [load]);

  const dirty = !notesEqual(draft, saved);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const save = useCallback(async () => {
    if (!job || !dirty || saving) return;
    setSaving(true);
    const notes = serializeNotes(draft);
    const { error } = await supabase.from("job_postings").update({ notes }).eq("id", job.id);
    setSaving(false);
    if (error) return setError(error.message);
    setSaved(parseNotes(notes));
    setJob({ ...job, notes });
    flash("Notes saved");
  }, [job, dirty, saving, draft]);

  // Cmd/Ctrl+S saves the tab you're looking at.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, save]);

  const jd = app?.jd_snapshot || job?.description || null;
  const cv = useMemo(() => resumes.find((r) => r.id === cvId) ?? null, [resumes, cvId]);

  async function copy(kind: "tailor" | "prep") {
    if (!job) return;
    // Uses what's on screen, saved or not.
    const notes = serializeNotes(draft);
    try {
      const text = kind === "tailor"
        ? buildTailorPrompt({ company: job.company_name, title: job.title, jd, notes, cv, skills: skillLines })
        : await buildPrepPrompt({ applicationId: app!.id, company: job.company_name, title: job.title,
                                  appliedAt: app!.applied_at, jd, resumeId: app!.resume_id, notes, skills: skillLines });
      await navigator.clipboard.writeText(text);
      flash(kind === "tailor" ? "CV-tailoring prompt copied" : "Interview-prep prompt copied");
    } catch {
      flash("Couldn't copy to the clipboard");
    }
  }

  async function triage(action: "apply" | "skip" | "reset", reason?: string) {
    if (!job) return;
    const url = job.apply_url ?? job.source_url;
    const win = action === "apply" && url ? window.open("about:blank", "_blank") : null;
    const { data, error } = await supabase.rpc("triage_posting", { p_posting_id: job.id, p_action: action, p_reason: reason ?? null });
    setSkipping(false);
    if (error) { win?.close(); return setError(error.message); }
    if (win && url) win.location.href = url;
    setJob({ ...job, triage_status: data.triage_status, skip_reason: data.skip_reason });
    if (action === "apply") {
      const a = await supabase.from("applications").select("id,applied_at,jd_snapshot,resume_id")
        .eq("job_posting_id", job.id).is("deleted_at", null).maybeSingle();
      setApp((a.data as Application | null) ?? null);
    }
  }

  if (!job) return <p className="empty">{error ?? "Loading…"}</p>;

  const url = job.apply_url ?? job.source_url ?? undefined;
  const meta = [
    job.city ?? job.location_raw,
    job.remote_policy ? REMOTE[job.remote_policy] : null,
    job.posted_date ? `posted ${fmtDate(job.posted_date)}` : null,
    job.salary_text,
  ].filter(Boolean);
  const reqs = [
    ...(job.must_have_skills ?? []).map((s) => ({ s, must: true })),
    ...(job.nice_to_have_skills ?? []).map((s) => ({ s, must: false })),
  ];

  return (
    <div className="job-page">
      <div className="job-head">
        <div className="tags">
          <span className={`source source-${job.source}`}>{sourceLabel(job.source)}</span>
          {job.poster_type === "agency" && <span className="badge">agency</span>}
          {job.triage_status !== "new" && (
            <span className="badge">{job.triage_status}{job.skip_reason ? `: ${skipLabel(job.skip_reason)}` : ""}</span>
          )}
        </div>
        <h1>{job.title} {url && <a href={url} target="_blank" rel="noreferrer" aria-label="Open posting">↗</a>}</h1>
        <div className="company">{job.company_name}</div>
        {meta.length > 0 && <div className="meta">{meta.join(" · ")}</div>}
        <Why p={job} />
        <div className="actions">
          {job.triage_status === "new" && (
            <>
              <button className="primary" onClick={() => triage("apply")}>Apply</button>
              <button onClick={() => setSkipping((s) => !s)}>Skip</button>
            </>
          )}
          {job.triage_status === "skipped" && <button onClick={() => triage("reset")}>Undo skip</button>}
          {app && <a href="#applications" className="link-button">In Applications{app.applied_at ? ` · applied ${fmtDate(app.applied_at.slice(0, 10))}` : ""}</a>}
        </div>
        {skipping && (
          <div className="reasons">
            {SKIP_REASONS.map((r) => (
              <button key={r.key} className="chip" onClick={() => triage("skip", r.key)}>{r.label}</button>
            ))}
          </div>
        )}
      </div>
      {error && <p className="notice">{error}</p>}

      <div className="job-body">
        <div className="job-main">
          <div className="tabs pane-tabs">
            <button className={pane === "notes" ? "active" : ""} onClick={() => setPane("notes")}>Notes{dirty ? " ●" : ""}</button>
            <button className={pane === "cv" ? "active" : ""} onClick={() => setPane("cv")}>CV</button>
          </div>
          {/* Both stay mounted, so switching keeps unsaved notes and the CV draft. */}
          <div hidden={pane !== "notes"}>
          <section className="notepad">
            <div className="notepad-head">
              <h2>Notes</h2>
              <span className="muted">{saving ? "Saving…" : dirty ? "Unsaved changes" : job.notes ? "Saved" : ""}</span>
              <button className="primary small" disabled={!dirty || saving} onClick={save} title="Cmd/Ctrl+S">Save</button>
            </div>
            {NOTE_FIELDS.map((f) => (
              <label key={f.key} className="note-field">
                <span>{f.label}</span>
                <textarea rows={f.key === "achievements" ? 6 : 4} placeholder={f.hint} value={draft[f.key]}
                          onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} />
              </label>
            ))}
            <div className="prompt-row">
              <select value={cvId} onChange={(e) => setCvId(e.target.value)} aria-label="Base CV for the prompt">
                <option value="">No base CV</option>
                {resumes.map((r) => (
                  <option key={r.id} value={r.id}>{r.uid}{r.label ? ` · ${r.label}` : ""}{r.extracted_text ? "" : " (no text)"}</option>
                ))}
              </select>
              <button className="small" onClick={() => copy("tailor")} title="Job description, your notes and the base CV, for any LLM">
                Copy CV-tailoring prompt
              </button>
              {app && <button className="small" onClick={() => copy("prep")}>Copy interview-prep prompt</button>}
            </div>
          </section>
          </div>
          <div hidden={pane !== "cv"} className="notepad">
            <CvBuilder job={job} active={active && pane === "cv"} />
          </div>
        </div>

        <aside className="job-side">
          <OutreachPanel job={job} applicationId={app?.id ?? null} sender={sender} />
          {(reqs.length > 0 || job.german_level || job.required_years != null) && (
            <>
              <h3>Requirements</h3>
              <div className="muted small-text">
                {[job.german_level === "none" ? "no German needed" : job.german_level ? `German ${job.german_level}` : null,
                  job.required_years != null ? `${job.required_years}+ years` : null,
                  job.seniority].filter(Boolean).join(" · ")}
              </div>
              <JobSkills jobId={job.id} must={job.must_have_skills ?? []} nice={job.nice_to_have_skills ?? []} onLines={setSkillLines} />
            </>
          )}
          <h3>Job description{app?.jd_snapshot ? " (saved copy)" : ""}</h3>
          {jd ? (
            <>
              <div className="jd jd-full">{jd}</div>
              <button className="link" onClick={() => navigator.clipboard.writeText(jd).then(() => flash("Job description copied"))}>Copy</button>
            </>
          ) : (
            <p className="muted">No description stored for this job.{app ? " Paste one in the application's details." : ""}</p>
          )}
        </aside>
      </div>
      {toast && active && <div className="toast">{toast}</div>}
    </div>
  );
}
