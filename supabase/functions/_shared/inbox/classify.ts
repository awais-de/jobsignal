// Rules-based email classification (spec 10.3). No LLM reads email (decision 14):
// conflicts and no-match cases get low confidence and go to the manual queue.
import { atsForDomain } from "./extract.ts";

export type Category =
  | "application_confirmation" | "rejection" | "interview_invitation" | "interview_scheduled" | "assessment"
  | "info_request" | "offer" | "account_created" | "job_alert" | "other";

export type Classification = { category: Category; confidence: number; candidates: Category[] };

// Job-alert senders (spec 7.1 tier 5). StepStone's are parsed into postings by the pipeline (sources/alerts.py).
const ALERT_DOMAINS = ["linkedin.com", "xing.com", "stepstone.de", "stepstone.com", "indeed.com", "indeed.de",
                       "jobs.lever.co", "glassdoor.com", "glassdoor.de"];
const ALERT_SUBJECT = /\b(job ?alert|jobs? für sie|neue jobs|new jobs for you|jobs you might|passende jobs|job-empfehlungen|jobempfehlung)\b/i;

// Patterns are phrases, not single words: confirmation templates often mention interviews
// ("we'll invite you to an interview if…") and many emails contain "leider" somewhere.
const RULES: [Category, RegExp][] = [
  ["offer", /\b(vertragsangebot|arbeitsvertrag(sentwurf)?|angebot (für|über) (eine|die) (anstellung|position)|offer letter|job offer|pleased to offer|happy to offer you|we would like to offer you)\b/i],
  ["interview_invitation", /(einladung zu(m|r)? (einem |einer )?(persönlichen |telefonischen |virtuellen |digitalen |ersten |zweiten )?(vorstellungsgespräch|kennenlern(gespräch|termin)|interview|gespräch|video-?call)|laden (wir )?sie (gerne |herzlich )?(zu|zum|zur) (einem |einer )?(persönlichen |ersten |telefonischen |virtuellen )?(vorstellungsgespräch|gespräch|interview|kennenlern)|möchten (wir )?sie (gerne |gern )?(kennenlernen|zu einem gespräch)|terminvorschl(a|ä)g|invite you (to|for) (an?|the) (first |initial |technical |video |phone )?(interview|call|conversation|chat)|invitation to (an? )?(interview|call)|(schedule|book) (an?|your) (interview|call|time)|next step (is|would be) (an?|the) (interview|call))/i],
  // A booked slot (booking tools, calendar invites, "your appointment is confirmed"), as opposed to an invitation.
  ["interview_scheduled", /(your appointment (will be|is) with|(ihr|dein) termin (wurde |ist )?(erfolgreich )?(gebucht|bestätigt|vereinbart)|terminbestätigung|termin(e)? (wurde|ist) (erfolgreich )?(gebucht|bestätigt)|(booking|appointment|meeting|interview) (is |has been )?(confirmed|scheduled|booked)|you('re| are) (all )?(scheduled|booked)|(new|confirmed) (event|appointment|booking)\s*:|^(einladung|invitation|eingeladen|aktualisierte einladung|updated invitation)\s*:.{3,120}@)/im],
  ["assessment", /(coding[- ]challenge|case[- ]study|testaufgabe|probeaufgabe|online[- ]test|online[- ]assessment|take[- ]home|technical (assessment|task|exercise)|hackerrank|codility|coderbyte|testgorilla)/i],
  ["info_request", /(fehlende unterlagen|unterlagen nachreichen|bitte reichen sie|bitte senden sie uns|please (provide|send us|submit) (the |your )?(missing|additional|following)|additional documents|missing documents)/i],
  ["rejection", /(leider (müssen|können) wir (ihnen )?(mitteilen|keine|nicht)|bedauerlicherweise (müssen|können|konnten|haben) wir|(momentan|derzeit|aktuell|leider) keine (stelle|position) anbieten|keine (stelle|position) anbieten können|(nicht|keine) (weiter )?(berücksichtig|in die engere auswahl)|absage|anderen? (kandidat|bewerber)(in|innen)?en? (entschieden|den vorzug)|für (eine|einen) andere(n)? (kandidat|bewerber)|unfortunately,? (we|i) (will not|won't|are unable|have decided|cannot|can't|must)|not (be )?(moving|move|proceed(ing)?) forward|decided to (move forward|proceed|pursue|go ahead) with other|other candidates (whose|who)|regret to inform|position has been filled|stelle (wurde )?(bereits )?(anderweitig )?besetzt)/i],
  ["application_confirmation", /(eingangsbestätigung|bewerbung (ist )?(bei uns )?(erfolgreich )?eingegangen|(vielen |herzlichen )?danke? für (ihre|deine) bewerbung|(ihre|deine) bewerbung erhalten haben|wir haben (ihre|deine) bewerbung (erhalten|bekommen)|we (have )?received your application|thank you for (your application|applying)|thanks for applying|application (has been )?received|your application (for|to) .{0,80} (has been|was) (submitted|received))/i],
  ["account_created", /(konto (wurde )?(erfolgreich )?(erstellt|angelegt)|neues benutzerkonto|benutzerkonto (wurde )?(erfolgreich )?(erstellt|angelegt)|registrierung war erfolgreich|registrierung (zu )?(bestätigen|abzuschließen|abschließen|erfolgreich)|e-?mail-?adresse (zu )?(bestätigen|verifizieren)|(bestätigen|verifizieren) sie (bitte )?(ihre|deine) e-?mail|verify your (email|account)|confirm your (email|account|registration)|account (has been )?created|activate your account|welcome to .{0,40}(career|talent|job) (portal|community|network))/i],
];

const INTERVIEW_CONTEXT = /(interview|kennenlern|vorstellungsgespräch|bewerbungsgespräch|erstgespräch|recruit)/i;
const JOB_CONTEXT = /(karriere|career|jobs?\b|bewerb|talent|recruit|stellen|candidate|kandidat|applicant|vacanc)/i;

// When several categories match, the more specific/urgent one wins (and confidence drops).
const PRIORITY: Category[] = ["offer", "interview_scheduled", "interview_invitation", "assessment", "info_request", "rejection",
                              "account_created", "application_confirmation"];

export function classify(fromDomain: string, subject: string, body: string): Classification {
  const domain = fromDomain.toLowerCase();
  // StepStone's job agent only sends jobs, whatever the subject ("Du passt perfekt: …", "Wenig Bewerber bisher").
  if (/(^|\.)jobagent\.stepstone\.(de|com)$/.test(domain)) return { category: "job_alert", confidence: 0.95, candidates: ["job_alert"] };
  if (ALERT_DOMAINS.some((d) => domain === d || domain.endsWith("." + d)) && (ALERT_SUBJECT.test(subject) || /job/i.test(subject))) {
    return { category: "job_alert", confidence: 0.9, candidates: ["job_alert"] };
  }
  // Subject is the strongest signal; body checked on its first part (templates put the gist up top).
  const head = `${subject}\n${body.slice(0, 4000)}`;
  let hits = RULES.filter(([, re]) => re.test(head)).map(([c]) => c);
  // "Confirm your email" is only a job-portal registration with job context (not e.g. a SaaS sign-up).
  if (hits.includes("account_created") && !atsForDomain(domain) && !JOB_CONTEXT.test(`${domain}\n${head}`)) {
    hits = hits.filter((c) => c !== "account_created");
  }
  // A booked meeting is only an interview with interview or job context (not a dentist's appointment).
  if (hits.includes("interview_scheduled") && !INTERVIEW_CONTEXT.test(head) && !JOB_CONTEXT.test(`${domain}\n${head}`)) {
    hits = hits.filter((c) => c !== "interview_scheduled");
  }
  if (hits.length === 0) return { category: "other", confidence: 0.5, candidates: [] };
  const ordered = PRIORITY.filter((c) => hits.includes(c));
  // A confirmation that merely mentions a later interview stays a confirmation when the subject says so.
  if (ordered.length > 1 && ordered.includes("application_confirmation") && ordered.includes("interview_invitation")
      && RULES.find(([c]) => c === "application_confirmation")![1].test(subject)
      && !RULES.find(([c]) => c === "interview_invitation")![1].test(subject)) {
    return { category: "application_confirmation", confidence: 0.7, candidates: ordered };
  }
  return { category: ordered[0], confidence: ordered.length === 1 ? 0.9 : 0.6, candidates: ordered };
}
