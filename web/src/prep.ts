import { notesForPrompt } from "./notes";
import { supabase } from "./supabase";

// Interview-prep prompt: everything an LLM needs, copied to the clipboard in one tap.

export const INTERVIEW_KINDS: Record<string, string> = {
  phone_screen: "Phone screen", hr: "HR interview", technical: "Technical interview",
  case_study: "Case study", onsite: "On-site interview", final: "Final round", other: "Other",
};

type PrepInput = {
  applicationId: string;
  company: string;
  title: string;
  appliedAt: string | null;
  jd: string | null;
  resumeId: string | null;
  notes?: string | null;   // the job's notepad (labelled sections)
  skills?: string;         // my honest self-ratings for this job's skills (skills database)
};

const fmt = (iso: string | null, time = false) =>
  !iso ? "unknown" : new Date(iso).toLocaleString("en-GB", {
    day: "2-digit", month: "long", year: "numeric", ...(time ? { hour: "2-digit", minute: "2-digit" } : {}),
  });

export async function buildPrepPrompt(a: PrepInput): Promise<string> {
  const [interview, email, resume] = await Promise.all([
    supabase.from("application_events").select("event_type,occurred_at,scheduled_for,interview_kind,notes")
      .eq("application_id", a.applicationId).in("event_type", ["interview_scheduled", "interview_invited"])
      .order("occurred_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("inbound_emails").select("subject,received_at,body_text")
      .eq("application_id", a.applicationId).in("category", ["interview_invitation", "assessment"])
      .order("received_at", { ascending: false }).limit(1).maybeSingle(),
    a.resumeId
      ? supabase.from("resumes").select("uid,label,extracted_text").eq("id", a.resumeId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const iv = interview.data as { scheduled_for: string | null; interview_kind: string | null; notes: string | null } | null;
  const em = email.data as { subject: string | null; received_at: string | null; body_text: string | null } | null;
  const cv = resume.data as { uid: string; label: string | null; extracted_text: string | null } | null;

  const section = (title: string, body: string) => `## ${title}\n${body.trim()}\n`;
  return [
    "# Interview preparation",
    "",
    "You are an experienced interview coach. Help me prepare for the interview described below, using only " +
    "the job description, my CV and the interview invitation provided. Please:",
    "1. Summarise what this role and company care about most, in 5 bullet points.",
    "2. Map the job's requirements to concrete evidence from my CV, and point out honest gaps with how to address them.",
    "3. List the 10 most likely questions for this type of interview (technical and behavioural), each with a short, " +
    "STAR-style answer outline grounded in my real experience. Don't invent experience I don't have.",
    "4. Suggest 5 thoughtful questions I can ask them.",
    "5. Give me a focused prep plan for the time left before the interview.",
    "If something important is missing, ask me before answering.",
    "",
    section("Company and role", `${a.company} – ${a.title}`),
    section("Date applied", fmt(a.appliedAt)),
    section("Interview", [
      `Date/time: ${iv?.scheduled_for ? fmt(iv.scheduled_for, true) : "not set yet"}`,
      `Kind: ${iv?.interview_kind ? INTERVIEW_KINDS[iv.interview_kind] : "not specified"}`,
      iv?.notes ? `Notes: ${iv.notes}` : "",
    ].filter(Boolean).join("\n")),
    section("Interview invitation email", em?.body_text
      ? `Subject: ${em.subject ?? ""}\nReceived: ${fmt(em.received_at, true)}\n\n${em.body_text}`
      : "(no interview email on record)"),
    section("Job description", a.jd || "(no job description stored — paste it here)"),
    ...(a.notes ? [section("My notes for this job", notesForPrompt(a.notes)!)] : []),
    ...(a.skills ? [section("My honest self-ratings for this job's skills (0–10)",
      `${a.skills}\n\nPrepare me realistically: for weak or presented-above-base skills, give likely probing questions and honest ` +
      "ways to answer from my real experience.")] : []),
    section(`My CV${cv ? ` (${cv.uid}${cv.label ? `, ${cv.label}` : ""})` : ""}`, cv?.extracted_text
      || "(CV text not stored — attach or paste the CV I sent here)"),
  ].join("\n");
}
