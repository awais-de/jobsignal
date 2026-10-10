import { useState } from "react";
import { supabase } from "./supabase";

// Resume versions (spec 6.4), registered by pasting a Google Drive link.
// UID scheme: R-YYMMDD-LANG-LAYOUT-NN, e.g. R-261011-EN-1C-01.

export type Resume = {
  id: string;
  uid: string;
  label: string | null;
  drive_file_id: string;
  drive_url: string | null;
  created_at: string;
};

export const RESUME_COLUMNS = "id,uid,label,drive_file_id,drive_url,created_at";

/** Extracts the file id from the usual Drive/Docs share-link shapes. */
export function driveFileId(url: string): string | null {
  const m = url.match(/\/d\/([\w-]{20,})/) ?? url.match(/[?&]id=([\w-]{20,})/);
  return m ? m[1] : null;
}

export const driveUrl = (id: string) => `https://drive.google.com/file/d/${id}/view`;

export function suggestUid(lang: "EN" | "DE", layout: "1C" | "2C", existing: Resume[], today = new Date()): string {
  const ymd = `${String(today.getFullYear()).slice(2)}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const prefix = `R-${ymd}-${lang}-${layout}-`;
  const n = existing.filter((r) => r.uid.startsWith(prefix)).length + 1;
  return `${prefix}${String(n).padStart(2, "0")}`;
}

export function ResumeLink({ r }: { r: Resume | undefined }) {
  if (!r) return <span className="muted">–</span>;
  return (
    <a className="resume-chip" href={r.drive_url ?? driveUrl(r.drive_file_id)} target="_blank" rel="noreferrer"
       title={r.label ?? undefined} onClick={(e) => e.stopPropagation()}>
      {r.uid}
    </a>
  );
}

export function ResumePicker({ resumes, value, onPick, onCreated, onError }: {
  resumes: Resume[];
  value: string | null;
  onPick: (id: string | null) => void;
  onCreated: (r: Resume) => void;
  onError: (msg: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState("");
  const [lang, setLang] = useState<"EN" | "DE">("EN");
  const [layout, setLayout] = useState<"1C" | "2C">("1C");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const fileId = driveFileId(link);
  const uid = suggestUid(lang, layout, resumes);

  async function register() {
    if (!fileId) return;
    setBusy(true);
    const { data, error } = await supabase.from("resumes").insert({
      uid,
      label: label.trim() || null,
      language: lang.toLowerCase(),
      layout: layout === "1C" ? "single_column" : "two_column",
      drive_file_id: fileId,
      drive_url: driveUrl(fileId),
    }).select(RESUME_COLUMNS).single();
    setBusy(false);
    if (error) {
      return onError(error.code === "23505" ? "That Drive file is already registered: pick it from the list." : error.message);
    }
    onCreated(data as Resume);
    onPick((data as Resume).id);
    setAdding(false);
    setLink("");
    setLabel("");
  }

  return (
    <div className="picker">
      <select value={value ?? ""} onChange={(e) => onPick(e.target.value || null)} aria-label="Resume sent">
        <option value="">No resume recorded</option>
        {resumes.map((r) => (
          <option key={r.id} value={r.id}>{r.uid}{r.label ? ` · ${r.label}` : ""}</option>
        ))}
      </select>
      <button className="link" onClick={() => setAdding((a) => !a)}>{adding ? "Cancel" : "+ Register a resume"}</button>
      {adding && (
        <div className="register">
          <input placeholder="Paste the Google Drive link to the PDF" value={link}
                 onChange={(e) => setLink(e.target.value)} />
          <div className="row">
            <select value={lang} onChange={(e) => setLang(e.target.value as "EN" | "DE")} aria-label="Language">
              <option value="EN">English</option>
              <option value="DE">German</option>
            </select>
            <select value={layout} onChange={(e) => setLayout(e.target.value as "1C" | "2C")} aria-label="Layout">
              <option value="1C">Single column</option>
              <option value="2C">Two column</option>
            </select>
            <input placeholder="Label (optional), e.g. data eng focus" value={label}
                   onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="row">
            <span className="muted">UID: <strong>{uid}</strong>{link && !fileId && " · not a Drive file link"}</span>
            <button className="primary small" disabled={!fileId || busy} onClick={register}>Register and use</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function CoverLetter({ fileId, onSave }: { fileId: string | null; onSave: (id: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [link, setLink] = useState("");
  const parsed = driveFileId(link);

  if (fileId && !editing) {
    return (
      <span>
        <a href={driveUrl(fileId)} target="_blank" rel="noreferrer">Open cover letter</a>{" "}
        <button className="link" onClick={() => setEditing(true)}>Change</button>
        <button className="link danger" onClick={() => onSave(null)}>Remove</button>
      </span>
    );
  }
  return (
    <div className="row">
      <input placeholder="Paste the Drive link (leave empty if none was sent)" value={link}
             onChange={(e) => setLink(e.target.value)} />
      <button className="small" disabled={!parsed} onClick={() => { onSave(parsed); setEditing(false); setLink(""); }}>
        Save
      </button>
      {editing && <button className="link" onClick={() => setEditing(false)}>Cancel</button>}
    </div>
  );
}
