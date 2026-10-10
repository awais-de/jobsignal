import { useEffect, useState } from "react";
import { RESUME_COLUMNS, ResumePicker, type Resume } from "./Resumes";
import { supabase } from "./supabase";

// Manual add (spec 9.3): paste a URL or the job text, review what was extracted, save as applied.

type Fields = Record<string, any>;

const ERRORS: Record<string, string> = {
  linkedin: "LinkedIn pages can't be fetched (by design). Paste the job text instead.",
  invalid_url: "That doesn't look like a public job page URL.",
  fetch_failed: "Couldn't load that page. Paste the job text instead.",
  too_little_text: "Not enough text to work with. Paste the full job description.",
  llm_unavailable: "Automatic analysis is busy right now. Fill in the fields yourself, or try again in a minute.",
  llm_not_configured: "Automatic analysis isn't set up yet. Fill in the fields yourself.",
};

const today = () => new Date().toISOString().slice(0, 10);

export default function ManualAdd() {
  const [mode, setMode] = useState<"url" | "text">("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Fields | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [appliedOn, setAppliedOn] = useState(today());
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [resumeId, setResumeId] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("resumes").select(RESUME_COLUMNS).is("deleted_at", null).order("created_at", { ascending: false })
      .then(({ data }) => data && setResumes(data as Resume[]));
  }, []);

  async function analyse() {
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.functions.invoke("manual-add", {
      body: { op: "analyse", ...(mode === "url" ? { url } : { text, url: url || undefined }) },
    });
    setBusy(false);
    const body = data ?? (await readError(error));
    if (body?.error && !body.fields) return setError(ERRORS[body.error] ?? "Something went wrong.");
    if (body?.error) setError(ERRORS[body.error] ?? null);
    setFields(body.fields ?? {});
    setDescription(body.description ?? (mode === "text" ? text : null));
    if (body.url) setUrl(body.url);
  }

  async function save() {
    if (!fields) return;
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("manual-add", {
      body: {
        op: "save",
        posting: { ...fields, description, url: url || null },
        applied_at: new Date(appliedOn + "T12:00:00").toISOString(),
        resume_id: resumeId,
      },
    });
    setBusy(false);
    const body = data ?? (await readError(error));
    if (body?.error) return setError(body.error === "title_and_company_required"
      ? "Title and company are required." : "Saving failed. Try again.");
    window.location.hash = "#applications";
  }

  const set = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }));

  return (
    <div className="add">
      <h2>Add a job you applied to</h2>
      <p className="muted">For applications outside the feed. Paste the link, or the job text if the page can't be fetched.</p>

      <div className="tabs">
        <button className={mode === "url" ? "active" : ""} onClick={() => setMode("url")}>Link</button>
        <button className={mode === "text" ? "active" : ""} onClick={() => setMode("text")}>Paste text</button>
      </div>
      {mode === "url" ? (
        <input className="wide" type="url" placeholder="https://company.example/jobs/data-engineer"
               value={url} onChange={(e) => setUrl(e.target.value)} />
      ) : (
        <>
          <textarea className="wide" rows={8} placeholder="Paste the full job description"
                    value={text} onChange={(e) => setText(e.target.value)} />
          <input className="wide" type="url" placeholder="Link to the posting (optional)"
                 value={url} onChange={(e) => setUrl(e.target.value)} />
        </>
      )}
      <button className="primary" disabled={busy || (mode === "url" ? !url : text.length < 80)} onClick={analyse}>
        {busy && !fields ? "Analysing…" : "Analyse"}
      </button>
      {error && <p className="notice">{error}</p>}

      {fields && (
        <div className="card review">
          <label>Title<input value={fields.title ?? ""} onChange={(e) => set("title", e.target.value)} /></label>
          <label>Company<input value={fields.company_name ?? ""} onChange={(e) => set("company_name", e.target.value)} /></label>
          <label>City<input value={fields.city ?? ""} onChange={(e) => set("city", e.target.value)} /></label>
          <label>Applied on<input type="date" value={appliedOn} max={today()}
                                  onChange={(e) => setAppliedOn(e.target.value)} /></label>
          <div className="label">Resume sent
            <ResumePicker resumes={resumes} value={resumeId} onPick={setResumeId} onError={setError}
                          onCreated={(r) => setResumes((rs) => [r, ...rs])} />
          </div>
          {(fields.must_have_skills?.length > 0 || fields.german_level || fields.required_years != null) && (
            <div className="muted extracted">
              {fields.must_have_skills?.length > 0 && <div>Must-haves: {fields.must_have_skills.join(", ")}</div>}
              {[fields.german_level && fields.german_level !== "none" ? `German ${fields.german_level}` : null,
                fields.required_years != null ? `${fields.required_years}+ yrs` : null,
                fields.contract_type, fields.remote_policy].filter(Boolean).join(" · ")}
            </div>
          )}
          <button className="primary" disabled={busy || !fields.title || !fields.company_name} onClick={save}>
            {busy ? "Saving…" : "Save as applied"}
          </button>
        </div>
      )}
    </div>
  );
}

async function readError(error: unknown): Promise<Fields | null> {
  // supabase-js puts non-2xx bodies on error.context (a Response).
  const ctx = (error as { context?: Response } | null)?.context;
  try {
    return ctx ? await ctx.json() : { error: "network" };
  } catch {
    return { error: "network" };
  }
}
