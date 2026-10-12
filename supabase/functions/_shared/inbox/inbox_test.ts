// Run: deno test supabase/functions/_shared/inbox/
// All sample emails are written by hand with invented companies (spec 13.1: no real emails in fixtures).
import { assertEquals, assert } from "jsr:@std/assert@1.0.13";
import { classify } from "./classify.ts";
import { extractFields, unforward } from "./extract.ts";
import { matchApplication } from "./match.ts";
import { normalizeCompany, normalizeTitle, sameCompany, titleSimilarity } from "./normalize.ts";

// ---- normalize: same vectors as tests/test_normalize.py ---------------------------
Deno.test("normalizeCompany matches the Python implementation", () => {
  const cases: [string, string][] = [
    ["Beispiel Daten GmbH", "beispiel daten"],
    ["Beispiel Daten GmbH & Co. KG", "beispiel daten"],
    ["Musterfirma AG", "musterfirma"],
    ["Exampleworks Inc.", "exampleworks"],
    ["Beispiel Daten GmbH Niederlassung Köln", "beispiel daten"],
    ["AGILE Muster", "agile muster"],
  ];
  for (const [raw, want] of cases) assertEquals(normalizeCompany(raw), want);
});

Deno.test("normalizeTitle strips gender markers", () => {
  assertEquals(normalizeTitle("Data Engineer (m/w/d)"), "data engineer");
  assertEquals(normalizeTitle("Data Science Engineer (m w d)"), "data science engineer");
  assertEquals(normalizeTitle("Dateningenieur*in"), "dateningenieur");
});

Deno.test("company and title comparison", () => {
  assert(sameCompany("Beispiel Daten GmbH", "Beispiel Daten"));
  assert(sameCompany("Musterfirma", "Musterfirma Deutschland AG"));
  assert(!sameCompany("Beispiel", "Anderes Beispiel Unternehmen GmbH") === false); // whole-word containment
  assert(!sameCompany("AB", "AB Logistik"));                                     // too short to trust
  assertEquals(titleSimilarity("Data Engineer (m/w/d)", "Data Engineer"), 1);
  assert(titleSimilarity("Senior Data Engineer", "Data Analyst") < 0.5);
});

// ---- classification ------------------------------------------------------------------
const C = (subject: string, body: string, domain = "beispiel-daten.de") => classify(domain, subject, body).category;

Deno.test("confirmations (DE/EN)", () => {
  assertEquals(C("Eingangsbestätigung Ihrer Bewerbung", "Vielen Dank für Ihre Bewerbung als Data Engineer."), "application_confirmation");
  assertEquals(C("Thank you for applying", "We have received your application for Data Engineer."), "application_confirmation");
  // mentions a later interview, but the subject says it's a confirmation
  assertEquals(C("Ihre Bewerbung ist eingegangen",
    "Vielen Dank für Ihre Bewerbung. Sollte Ihr Profil passen, laden wir Sie zu einem Vorstellungsgespräch ein."),
    "application_confirmation");
});

Deno.test("rejections (DE/EN)", () => {
  assertEquals(C("Ihre Bewerbung", "Leider müssen wir Ihnen mitteilen, dass wir uns für einen anderen Kandidaten entschieden haben."), "rejection");
  assertEquals(C("Your application", "Unfortunately, we have decided to move forward with other candidates."), "rejection");
  assertEquals(C("Update", "We regret to inform you that the position has been filled."), "rejection");
});

Deno.test("'leider' alone is not a rejection", () => {
  assertEquals(C("Terminverschiebung", "Leider ist mir etwas dazwischengekommen. Können wir den Termin verschieben?"), "other");
});

Deno.test("interview invitations (DE/EN)", () => {
  assertEquals(C("Einladung zum Vorstellungsgespräch", "Wir laden Sie herzlich zu einem persönlichen Gespräch ein."), "interview_invitation");
  assertEquals(C("Next steps", "We would like to invite you to a first interview with our team."), "interview_invitation");
  assertEquals(C("Kennenlernen", "Wir möchten Sie gerne kennenlernen. Hier ein Terminvorschlag: 14.10.2026 um 10:00 Uhr."), "interview_invitation");
});

Deno.test("assessment, info request, offer, account", () => {
  assertEquals(C("Coding Challenge", "Please complete the coding challenge within 5 days."), "assessment");
  assertEquals(C("Unterlagen", "Bitte reichen Sie noch Ihre Zeugnisse nach. Fehlende Unterlagen: Arbeitszeugnis."), "info_request");
  assertEquals(C("Your offer", "We are pleased to offer you the position of Data Engineer."), "offer");
  assertEquals(C("Bitte bestätigen", "Bitte bestätigen Sie Ihre E-Mail-Adresse, um Ihre Registrierung im Bewerberportal abzuschließen."), "account_created");
});

Deno.test("job alerts by sender", () => {
  assertEquals(classify("jobs-listings.linkedin.com", "Neue Jobs für Sie: Data Engineer", "...").category, "job_alert");
  assertEquals(classify("stepstone.de", "Ihr Job-Alert", "...").category, "job_alert");
});

Deno.test("conflicts lower confidence; urgent category wins", () => {
  const r = classify("beispiel.de", "Einladung zum Vorstellungsgespräch", "Leider müssen wir den ursprünglichen Termin absagen.");
  assertEquals(r.category, "interview_invitation");
  assert(r.confidence < 0.9 && r.candidates.includes("rejection"));
});

// ---- extraction ----------------------------------------------------------------------
Deno.test("extract company, role, reference, interview time", () => {
  const e = extractFields("Recruiting Team", "beispiel-daten.de", "Ihre Bewerbung bei Beispiel Daten GmbH",
    "Vielen Dank für Ihre Bewerbung als Data Engineer (m/w/d). Referenznummer: BD-2026-117.\n" +
    "Gerne laden wir Sie am 14.10.2026 um 10:30 Uhr ein.");
  assertEquals(e.company, "Beispiel Daten GmbH");
  assertEquals(e.role_title, "Data Engineer");   // gender marker dropped; matching normalizes it anyway
  assertEquals(e.reference_number, "BD-2026-117");
  assertEquals(e.interview_at, "2026-10-14T10:30");
});

Deno.test("ATS sender: company from display name, not the domain", () => {
  const e = extractFields("Musterfirma AG", "myworkday.com", "Thank you for applying", "We received your application for Analytics Engineer.");
  assertEquals(e.ats, "workday");
  assertEquals(e.company, "Musterfirma AG");
  assertEquals(e.role_title, "Analytics Engineer");
});

// ---- matching ------------------------------------------------------------------------
const OPEN = [
  { id: "a1", company: "Beispiel Daten GmbH", title: "Data Engineer (m/w/d)", reference_number: "BD-2026-117" },
  { id: "a2", company: "Beispiel Daten GmbH", title: "BI Developer", reference_number: null },
  { id: "a3", company: "Musterfirma AG", title: "Analytics Engineer", reference_number: null },
];

Deno.test("match order: thread, reference, company+title, company-only", () => {
  assertEquals(matchApplication({ company: null, role_title: null, reference_number: null }, OPEN, "a2")?.method, "thread");
  assertEquals(matchApplication({ company: "x", role_title: null, reference_number: "bd-2026-117" }, OPEN, null)?.application_id, "a1");
  assertEquals(matchApplication({ company: "Beispiel Daten", role_title: "BI Developer", reference_number: null }, OPEN, null)?.application_id, "a2");
  assertEquals(matchApplication({ company: "Musterfirma", role_title: null, reference_number: null }, OPEN, null)?.method, "company_only");
});

Deno.test("ambiguous company without title stays unmatched", () => {
  assertEquals(matchApplication({ company: "Beispiel Daten GmbH", role_title: null, reference_number: null }, OPEN, null), null);
});

// ---- regressions from the first live run (2026-10-11) ----------------------------------
Deno.test("SaaS sign-up is not a job-portal registration", () => {
  assertEquals(C("Confirm your email and launch your projects", "Please confirm your email address.", "cloudtool.example"), "other");
  assertEquals(classify("beispiel.myworkdayjobs.com", "Bitte bestätigen", "Bitte bestätigen Sie Ihre E-Mail-Adresse").category, "account_created");
  assertEquals(C("Willkommen im Karriereportal", "Bitte bestätigen Sie Ihre E-Mail-Adresse."), "account_created");
});

Deno.test("forwarded email: original sender, subject and body", () => {
  const body = "Hier die Bestätigung.\n\n---------- Forwarded message ---------\n" +
    "From: Beispielwerk Recruiting <jobs@beispielwerk.example>\nDate: Fri, 9 Oct 2026 at 10:00\n" +
    "Subject: Beispielwerk: Your Application confirmation - IT Project Manager (m/f/d)\nTo: <me@old.example>\n\n" +
    "Thank you for applying to Beispielwerk.";
  const f = unforward("Fwd: Beispielwerk: Your Application confirmation - IT Project Manager (m/f/d)", body)!;
  assertEquals(f.from, "Beispielwerk Recruiting <jobs@beispielwerk.example>");
  assertEquals(f.subject, "Beispielwerk: Your Application confirmation - IT Project Manager (m/f/d)");
  assert(f.body.startsWith("Thank you for applying"));
  assertEquals(unforward("Ihre Bewerbung", "no forward"), null);
});

Deno.test("company and role from a 'Company: Application confirmation - Role' subject", () => {
  const e = extractFields("Recruiting", "beispielwerk.example", "Beispielwerk: Your Application confirmation - IT Project Manager (m/f/d)",
    "Thank you for applying.");
  assertEquals(e.company, "Beispielwerk");
  assertEquals(e.role_title, "IT Project Manager");
});

Deno.test("HR-system sender: company from the text (legal form eG, article, wrapped line), not the domain", () => {
  const body = "Guten Tag,\n\nvielen Dank für Ihre Bewerbung und Ihr Interesse an einer Beschäftigung bei \n" +
    "der Beispielbank Musterstadt eG.\n\nWir haben Ihre Unterlagen erfolgreich erhalten.";
  const f = extractFields("", "geno.hr.peras.de", "Wir haben Ihre Bewerbung erhalten!", body,
                          "noreply-beispielbank-musterstadt");
  assertEquals(f.ats, "peras");
  assertEquals(f.company, "Beispielbank Musterstadt eG");
  const open = [{ id: "A1", company: "Beispielbank Musterstadt eG", title: "IT-Spezialist Data Engineer (m/w/d)", reference_number: null }];
  assertEquals(matchApplication(f, open, null)?.application_id, "A1");
});

Deno.test("HR-system sender without a name in the text: company from the sender's local part", () => {
  const f = extractFields("", "geno.hr.peras.de", "Wir haben Ihre Bewerbung erhalten!", "Vielen Dank.",
                          "noreply-beispielbank-musterstadt");
  assertEquals(f.company, "beispielbank musterstadt");
  const open = [{ id: "A1", company: "Beispielbank Musterstadt eG", title: "Data Engineer", reference_number: null }];
  assertEquals(matchApplication(f, open, null)?.application_id, "A1");
});
