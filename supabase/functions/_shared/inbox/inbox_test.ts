// Run: deno test supabase/functions/_shared/inbox/
// All sample emails are written by hand with invented companies (spec 13.1: no real emails in fixtures).
import { assertEquals, assert } from "jsr:@std/assert@1.0.13";
import { classify } from "./classify.ts";
import { berlinToUtc, extractFields, icsStart, interviewTime, unforward } from "./extract.ts";
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

Deno.test("booking confirmation is 'interview scheduled'; date from the calendar invite or the HTML text", () => {
  const body = "Your appointment will be with Anna Muster.\nIhr Kennenlernen mit Anna Muster\nMicrosoft Teams-Besprechung";
  assertEquals(classify("beispiel.onmicrosoft.com", "Ihr Kennenlernen mit der Beispiel AG Musterstadt - Max Kandidat", body).category,
               "interview_scheduled");
  assertEquals(classify("kalender.example", "Termin bestätigt", "Ihr Termin wurde gebucht: Zahnreinigung").category, "other");
  assertEquals(icsStart("BEGIN:VEVENT\r\nDTSTART;TZID=W. Europe Standard Time:20261014T100000\r\nEND:VEVENT"), "2026-10-14T10:00");
  assertEquals(icsStart("DTSTART:20261014T080000Z"), "2026-10-14T10:00");
  const now = new Date("2026-10-13T12:00:00Z");
  assertEquals(interviewTime(["Mittwoch, 14. Oktober 2026, 10:00 Uhr – 10:30 Uhr"], now), "2026-10-14T10:00");
  assertEquals(interviewTime(["Thursday, October 15, 2026 2:30 PM"], now), "2026-10-15T14:30");
  assertEquals(interviewTime(["3 junior roles in 14 markets, call 0351 4391026"], now), null);
  assertEquals(berlinToUtc("2026-10-14T10:00"), "2026-10-14T08:00:00.000Z");
  assertEquals(berlinToUtc("2026-12-14T10:00"), "2026-12-14T09:00:00.000Z");
});

Deno.test("more confirmations and portal accounts", () => {
  assertEquals(classify("beispiel.de", "Danke für Ihre Bewerbung!", "wir freuen uns, dass wir Ihre Bewerbung erhalten haben").category,
               "application_confirmation");
  assertEquals(classify("beispiel.de", "Neues Benutzerkonto im Beispiel Bewerbermanagementsystem", "Ihr Konto").category,
               "account_created");
});

Deno.test("company: subject '| Company', a person's display name is not a company, short names", () => {
  assertEquals(extractFields("Anna Muster", "beispiel-ag.de", "Einladung zum Interview | Beispiel AG", "Hallo", "anna.muster").company,
               "Beispiel AG");
  assertEquals(extractFields("Anna Muster", "beispiel-ag.de", "Termin", "Hallo", "anna.muster").company, "beispiel-ag");
  assertEquals(extractFields("Beispiel AG", "beispiel-ag.de", "Danke", "Hallo", "beispiel-ag").company, "Beispiel AG");
  assertEquals(extractFields("CHECK IN", "mein-check-in.de", "Beispielbank Musterstadt eG - Eingangsbestätigung", "Danke", "noreply").company,
               "Beispielbank Musterstadt eG");
  assert(sameCompany("ABC AG", "ABC Deutschland GmbH"));      // short name as the leading word
  assert(!sameCompany("ABC", "Paradies ABC GmbH"));
});

// 2026-10-21: a rejection via an HR system (geno.HR / Peras) was filed as a confirmation under 'geno.'.
Deno.test("an HR-system rejection: 'bedauerlicherweise … keine Stelle anbieten', company from the signature", () => {
  const body = `Guten Tag Frau Muster,
vielen Dank für Ihre Bewerbung und Ihr Interesse an unserem Unternehmen.
Das deutsche Sprachniveau von mindestens C1 ist für uns eine wesentliche Voraussetzung.
Bedauerlicherweise können wir Ihnen aufgrund dieser Anforderung momentan
keine Stelle anbieten.
Wir wünschen Ihnen alles Gute für Ihre berufliche Zukunft.
Freundliche Grüße
Ihr Recruiting-Team
Beispielbank Musterstadt eG
Telefon: 01234 5678
-----------------------------------------------------------　
Beispielbank Musterstadt eG
Eingetragen: GenR 5, Amtsgericht Musterstadt`;
  const flatBody = body.replace(/\n/g, " ");
  assertEquals(classify("geno.hr.peras.de", "Rückmeldung zu Ihrer Bewerbung", flatBody).category, "rejection");
  assertEquals(classify("geno.hr.peras.de", "Rückmeldung zu Ihrer Bewerbung", body).category, "rejection");
  assertEquals(extractFields("geno.HR", "geno.hr.peras.de", "Rückmeldung zu Ihrer Bewerbung", body, "noreply").company,
               "Beispielbank Musterstadt eG");
});

Deno.test("rejection reasons and their sentence", async () => {
  const { rejectionReason } = await import("./extract.ts");
  const cases: [string, string][] = [
    ["Das deutsche Sprachniveau von mindestens C1 ist eine wesentliche Voraussetzung. Bedauerlicherweise können wir Ihnen momentan keine Stelle anbieten.", "german_language"],
    ["Leider ist die Stelle bereits anderweitig besetzt.", "position_filled"],
    ["Wir haben uns für einen anderen Kandidaten entschieden, dessen Profil noch besser passt.", "other_candidates"],
    ["Leider entspricht Ihr Profil nicht ganz unserem Anforderungsprofil.", "profile_fit"],
    ["We are looking for candidates with more hands-on experience in Spark.", "experience"],
    ["Unfortunately we have decided to move forward with other candidates.", "other_candidates"],
    ["Für diese Position sind Sie überqualifiziert.", "overqualified"],
    ["Leider müssen wir Ihnen mitteilen, dass wir Sie nicht berücksichtigen können. Wir wünschen Ihnen alles Gute.", "not_given"],
  ];
  for (const [text, want] of cases) assertEquals(rejectionReason(text).rejection_reason, want, text);
  const r = rejectionReason("Vielen Dank.\nDas deutsche Sprachniveau von mindestens C1 ist für uns\neine wesentliche Voraussetzung. Alles Gute.");
  assertEquals(r.rejection_detail, "Das deutsche Sprachniveau von mindestens C1 ist für uns eine wesentliche Voraussetzung.");
});

// 2026-10-21: a rejection in the informal "Du" form ("Leider müssen wir Dir mitteilen …") was filed as a confirmation.
Deno.test("a 'Du' rejection with words between 'nicht weiter' and 'berücksichtigen'", () => {
  const body = `Hallo Erika,
vielen Dank für Deine Bewerbung auf die Stelle Junior BI Engineer (m/w/d) und das damit entgegengebrachte Interesse.
Leider müssen wir Dir mitteilen, dass wir Dich nicht weiter im
Bewerbungsprozess berücksichtigen können. Häufig sind es nur Nuancen, die den Ausschlag geben.
Wir wünschen Dir für Deine Zukunft alles Gute.`;
  assertEquals(classify("beispiel.com", "Deine Bewerbung bei Beispiel", body).category, "rejection");
  assertEquals(classify("beispiel.com", "Deine Bewerbung bei Beispiel", body.replace(/\n/g, " ")).category, "rejection");
  assertEquals(classify("beispiel.com", "Deine Bewerbung", "Wir haben Deine Bewerbung erhalten und melden uns bald.").category,
               "application_confirmation");
});
