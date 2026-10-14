// Per-job notepad. Edited as separate fields, stored in job_postings.notes as labelled text
// ("## Relevant achievements\n..."), so the stored value can go straight into an LLM prompt.

export const NOTE_FIELDS = [
  { key: "achievements", label: "Relevant achievements", hint: "What you did that proves you can do this job: numbers, scope, outcomes" },
  { key: "keywords", label: "Matching skills / keywords", hint: "Terms from the JD you genuinely have and should use in the CV" },
  { key: "gaps", label: "Gaps and how to address them", hint: "Requirements you don't fully meet, and your honest angle on each" },
  { key: "resume", label: "Resume changes for this job", hint: "Bullets to move up, rephrase, add or drop; which base CV to start from" },
  { key: "other", label: "Anything else", hint: "Contacts, company research, motivation, questions…" },
] as const;

export type NoteKey = (typeof NOTE_FIELDS)[number]["key"];
export type Notes = Record<NoteKey, string>;

const header = (label: string) => `## ${label}`;
const BY_HEADER = new Map<string, NoteKey>(NOTE_FIELDS.map((f) => [header(f.label), f.key]));

export const emptyNotes = (): Notes =>
  Object.fromEntries(NOTE_FIELDS.map((f) => [f.key, ""])) as Notes;

/** A line inside a field that looks exactly like a section label is escaped with a leading backslash. */
const escapeLine = (l: string) => (BY_HEADER.has(l.replace(/^\\+/, "")) ? `\\${l}` : l);
const unescapeLine = (l: string) => (l.startsWith("\\") && BY_HEADER.has(l.replace(/^\\+/, "")) ? l.slice(1) : l);

export function serializeNotes(n: Notes): string | null {
  const parts = NOTE_FIELDS
    .filter((f) => n[f.key].trim())
    .map((f) => `${header(f.label)}\n${n[f.key].trim().split("\n").map(escapeLine).join("\n")}`);
  return parts.length ? parts.join("\n\n") : null;
}

/** Text before any label (or with unknown labels) lands in "Anything else", so nothing is lost. */
export function parseNotes(text: string | null): Notes {
  const out = emptyNotes();
  if (!text) return out;
  const lines: Record<NoteKey, string[]> = Object.fromEntries(NOTE_FIELDS.map((f) => [f.key, []])) as never;
  let current: NoteKey = "other";
  for (const line of text.split("\n")) {
    const key = BY_HEADER.get(line);
    if (key) current = key;
    else lines[current].push(unescapeLine(line));
  }
  for (const f of NOTE_FIELDS) out[f.key] = lines[f.key].join("\n").trim();
  return out;
}

/** Notes nested under a prompt's "## My notes" section: their labels become sub-headings. */
export const notesForPrompt = (n: string | null | undefined) => (n ? n.replace(/^## /gm, "### ") : null);

export const notesEqual = (a: Notes, b: Notes) => NOTE_FIELDS.every((f) => a[f.key].trim() === b[f.key].trim());

/** CV-tailoring prompt: the job, the owner's notes and a base CV, copied in one tap. */
export function buildTailorPrompt(a: {
  company: string; title: string; jd: string | null; notes: string | null;
  cv: { uid: string; label: string | null; extracted_text: string | null } | null;
  skills?: string;          // my honest self-ratings for this job's skills (skills database)
}): string {
  const section = (title: string, body: string) => `## ${title}\n${body.trim()}\n`;
  return [
    "# Tailor my CV for this job",
    "",
    "You are an experienced recruiter and CV writer for the German job market. Using only the job description, " +
    "my notes and my CV below:",
    "1. List the 8–10 requirements this employer will screen for first.",
    "2. Rewrite my CV's profile summary (3–4 lines) for this role.",
    "3. Suggest the experience bullets to lead with, rewritten to match the job's wording where it is true for me. " +
    "Use my notes on achievements and keywords. Keep every claim grounded in my CV or notes: never invent experience, " +
    "tools, numbers or titles.",
    "4. Say which skills to list first, and which to drop as noise for this role.",
    "5. For each gap in my notes, suggest an honest way to address it (CV wording or cover-letter line).",
    "6. Flag ATS issues: missing exact keywords from the JD that I genuinely have.",
    "If something important is missing, ask me before answering.",
    "",
    section("Company and role", `${a.company} – ${a.title}`),
    section("Job description", a.jd || "(no job description stored — paste it here)"),
    section("My notes for this job", notesForPrompt(a.notes) || "(no notes yet)"),
    ...(a.skills ? [section("My honest self-ratings for this job's skills (0–10)",
      `${a.skills}\n\nUse these to lead with real strengths. Where I present a skill above my base rating, help me back it with ` +
      "evidence I actually have (projects, courses, adjacent tools); never claim more than the evidence supports.")] : []),
    section(`My base CV${a.cv ? ` (${a.cv.uid}${a.cv.label ? `, ${a.cv.label}` : ""})` : ""}`,
      a.cv?.extracted_text || "(CV text not stored — attach or paste my CV here)"),
  ].join("\n");
}
