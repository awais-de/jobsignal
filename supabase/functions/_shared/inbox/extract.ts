// Field extraction from an email (spec 10.4): company, role title, reference number, interview date.

// Senders that mail on behalf of employers: take the company from display name or text, not the domain.
export const ATS_DOMAINS: Record<string, string> = {
  "myworkday.com": "workday", "myworkdayjobs.com": "workday", "workday.com": "workday",
  "greenhouse.io": "greenhouse", "greenhouse-mail.io": "greenhouse", "lever.co": "lever", "hire.lever.co": "lever",
  "ashbyhq.com": "ashby", "personio.de": "personio", "personio.com": "personio", "jobs.personio.de": "personio",
  "successfactors.com": "successfactors", "successfactors.eu": "successfactors", "sapsf.eu": "successfactors",
  "smartrecruiters.com": "smartrecruiters", "softgarden.io": "softgarden", "softgarden.de": "softgarden",
  "join.com": "join", "recruitee.com": "recruitee", "workable.com": "workable", "teamtailor.com": "teamtailor",
  "teamtailor-mail.com": "teamtailor", "rexx-systems.com": "rexx", "dvinci-hr.com": "dvinci", "dvinci.de": "dvinci",
  "taleo.net": "taleo", "icims.com": "icims", "onlyfy.jobs": "onlyfy", "prescreen.io": "onlyfy",
  "concludis.de": "concludis", "umantis.com": "umantis", "haufe-umantis.com": "umantis",
  "bamboohr.com": "bamboohr", "jobylon.com": "jobylon",
};
const FREEMAIL = ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "gmx.de", "gmx.net", "web.de", "yahoo.com", "t-online.de"];
const NOREPLY_NAMES = /^(no-?reply|noreply|do-?not-?reply|recruiting|recruitment|careers?|karriere|jobs?|talent( acquisition)?|hr|personal(abteilung)?|bewerbermanagement|bewerbungen?|team)$/i;

export type Extracted = {
  company: string | null;
  role_title: string | null;
  reference_number: string | null;
  interview_at: string | null;        // ISO local datetime 'YYYY-MM-DDTHH:MM' when a date and time are given
  ats: string | null;
};

export function atsForDomain(domain: string): string | null {
  const d = domain.toLowerCase();
  for (const [suffix, ats] of Object.entries(ATS_DOMAINS)) {
    if (d === suffix || d.endsWith("." + suffix)) return ats;
  }
  return null;
}

const COMPANY_IN_TEXT = [
  /(?:ihre|deine) bewerbung (?:bei|an) (?:der |die |dem )?([A-ZÄÖÜ][\w&.\-' ]{1,60}?)(?:[,.!:\n]| als | für | - | – |$)/,
  /(?:your application (?:to|at|with)|applying (?:to|at)|interest in (?:joining |working at )?)([A-Z][\w&.\-' ]{1,60}?)(?:[,.!:\n]| for | as | - | – |$)/,
  /(?:bei|at) ([A-ZÄÖÜ][\w&.\-]+(?: [A-ZÄÖÜ&][\w&.\-]+){0,3} (?:GmbH|AG|SE|KG|Inc\.?|Ltd\.?)(?: & Co\. KG)?)/,
];
const ROLE_IN_TEXT = [
  /(?:bewerbung|bewerben|beworben)\s+(?:als|für die (?:stelle|position)(?: als)?|auf die (?:stelle|position)(?: als)?)\s+[„"]?([^\n„""",.!?]{3,90}?)[""""]?(?:\s+(?:bei|in|an|\(|-|–)|[,.!?\n]|$)/i,
  /(?:application for|applied for|applying for)\s+(?:the\s+)?(?:position|role|job)?\s*(?:of\s+)?[„"']?([^\n"'„"",.!?]{3,90}?)["'"]?(?:\s+(?:at|in|with|\(|-|–)|[,.!?\n]|$)/i,
  /(?:stelle|position|role|job)\s*:\s*([^\n]{3,90})/i,
];
const REFERENCE = /(?:referenz(?:nummer)?|ref(?:\.|erence)?\s*(?:no\.?|nr\.?|number|id)?|kennziffer|job[- ]?id|stellen[- ]?id|req(?:uisition)?\s*(?:id|no\.?))\s*[:#]?\s*([A-Z0-9][A-Z0-9_\-\/]{2,30})/i;

const DATE_DE = /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/;
const DATE_ISO = /\b(20\d{2})-(\d{2})-(\d{2})\b/;
const TIME = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:uhr|h|am|pm)?\b/i;

export function extractFields(fromName: string, fromDomain: string, subject: string, body: string): Extracted {
  const text = `${subject}\n${body.slice(0, 6000)}`;
  const ats = atsForDomain(fromDomain);

  let company: string | null = null;
  for (const re of COMPANY_IN_TEXT) {
    const m = text.match(re);
    if (m) {
      company = m[1].trim();
      break;
    }
  }
  const name = fromName.replace(/["']/g, "").trim();
  if (!company && name && !NOREPLY_NAMES.test(name) && !/@/.test(name)) {
    // "Beispiel Daten GmbH Recruiting" / "Talent Team at Beispiel" → the company part
    company = name.replace(/\b(recruiting|recruitment|careers?|karriere|talent( acquisition)?( team)?|hr|team|jobs)\b/gi, "")
      .replace(/\b(at|bei|von|from)\b/gi, "").replace(/[|·•\-–]+/g, " ").replace(/\s+/g, " ").trim() || null;
  }
  if (!company && !ats && fromDomain && !FREEMAIL.includes(fromDomain.toLowerCase())) {
    const parts = fromDomain.toLowerCase().split(".");
    company = parts.length >= 2 ? parts[parts.length - 2] : null;   // 'jobs.beispiel-daten.de' → 'beispiel-daten'
  }

  let role: string | null = null;
  for (const re of ROLE_IN_TEXT) {
    const m = text.match(re);
    if (m) {
      role = m[1].trim().replace(/\s+/g, " ");
      break;
    }
  }

  const ref = text.match(REFERENCE)?.[1] ?? null;

  let interview_at: string | null = null;
  const d = body.match(DATE_DE) ?? body.match(DATE_ISO);
  // Look for the time without the date, so '14.10.2026' isn't read as 14:10.
  const t = (d ? body.replace(d[0], " ") : body).match(TIME);
  if (d && t) {
    let y: number, mo: number, da: number;
    if (d[0].includes("-")) [y, mo, da] = [Number(d[1]), Number(d[2]), Number(d[3])];
    else [da, mo, y] = [Number(d[1]), Number(d[2]), Number(d[3].length === 2 ? "20" + d[3] : d[3])];
    let h = Number(t[1]);
    if (/pm/i.test(t[0]) && h < 12) h += 12;
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      interview_at = `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}T${String(h).padStart(2, "0")}:${t[2]}`;
    }
  }
  return { company, role_title: role, reference_number: ref, interview_at, ats };
}
