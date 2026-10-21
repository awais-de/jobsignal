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
  // German HR systems (2026-10-12: a Peras confirmation for a Volksbank was filed under 'geno.')
  "peras.de": "peras", "b-ite.com": "bite", "b-ite.de": "bite", "erecruiter.net": "erecruiter",
  "coveto.de": "coveto", "hr4you.org": "hr4you", "kenjo.io": "kenjo", "onapply.de": "onapply",
  "mein-check-in.de": "checkin",
};
const FREEMAIL = ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "gmx.de", "gmx.net", "web.de", "yahoo.com", "t-online.de"];
const NOREPLY_NAMES = /^(no-?reply|noreply|do-?not-?reply|recruiting|recruitment|careers?|karriere|jobs?|talent( acquisition)?|hr|personal(abteilung)?|bewerbermanagement|bewerbungen?|team)$/i;

export type Extracted = {
  company: string | null;
  role_title: string | null;
  reference_number: string | null;
  interview_at: string | null;        // ISO local datetime 'YYYY-MM-DDTHH:MM' when a date and time are given
  ats: string | null;
  rejection_reason?: string;        // rejections only: a category (see rejectionReason)
  rejection_detail?: string | null; // the sentence that gives it
};

// Why an application was declined (owner request 2026-10-21). Most specific first: a rejection letter often
// thanks, mentions other candidates and gives the real reason in one sentence.
const REJECTION_REASONS: [string, RegExp][] = [
  ["position_filled", /(stelle (wurde |ist )?(bereits |inzwischen |zwischenzeitlich )?(anderweitig |intern )?(besetzt|vergeben)|position (has been|was|is) (already )?(filled|closed)|role (has been|was) (filled|closed)|ausschreibung (wurde )?(zurückgezogen|gestoppt|beendet)|no longer (open|available|hiring)|nicht (mehr )?zu besetzen|besetzung (der stelle )?(wurde )?(gestoppt|zurückgestellt)|stelle (wird )?nicht (mehr )?(nach)?besetzt)/i],
  ["german_language", /((deutsch|german)\w*[^.!?\n]{0,80}(sprachniveau|sprachkenntnisse|niveau|level|c1|c2|b2|muttersprach|verhandlungssicher|fließend|fluent)|(sprachniveau|sprachkenntnisse|deutschkenntnisse)[^.!?\n]{0,80}(c1|c2|voraussetzung|erforderlich|nicht ausreichend|required)|german (language )?(skills|proficiency)|deutschkenntnisse)/i],
  ["overqualified", /(überqualifiziert|overqualified|zu (hoch|stark) qualifiziert)/i],
  ["experience", /((berufs)?erfahrung[^.!?\n]{0,60}(nicht ausreich|fehlt|zu gering|mehr|umfangreicher|tiefer|einschlägig)|(more|additional|relevant|sufficient|enough) (hands-on |professional )?experience|years of experience|mehr (berufs)?erfahrung|erfahrener(e|en)? (kandidat|bewerber))/i],
  ["location_permit", /(arbeitserlaubnis|aufenthaltstitel|work permit|visa sponsorship|visum|right to work|vor[- ]ort[^.!?\n]{0,40}(präsenz|anwesenheit|erforderlich)|wohnort|relocation)/i],
  ["salary", /(gehaltsvorstellung|gehaltsvorstellungen|salary expectation|compensation expectation|budget)/i],
  ["profile_fit", /((ihr |dein )?profil[^.!?\n]{0,60}(nicht|weniger|kaum)[^.!?\n]{0,40}(passt|entspricht|überein|deckt)|anforderungsprofil|(qualifikation|kenntnisse)[^.!?\n]{0,60}(nicht|weniger)[^.!?\n]{0,30}(entspr|überein|pass)|not (be )?(a|the) (right |best |strong )?(fit|match)|closer (match|fit)|(better|more closely) match(es)? (our|the) (requirements|needs))/i],
  ["other_candidates", /(andere[nr]? (kandidat|bewerber)|anderen (bewerber|kandidat)\w* den vorzug|für (eine|einen) andere(n)? (kandidat|bewerber)|other candidates|another candidate|decided to (move forward|proceed|go ahead) with (other|another))/i],
];

/** The reason a rejection gives, and its sentence; 'not_given' when it gives none. */
export function rejectionReason(body: string): { rejection_reason: string; rejection_detail: string | null } {
  const flat = body.slice(0, 8000).replace(/[ \t]*\r?\n[ \t]*/g, " ").replace(/\s+/g, " ");
  for (const [reason, re] of REJECTION_REASONS) {
    const m = re.exec(flat);
    if (!m) continue;
    // The sentence around the match (with the one before when the match opens its sentence: "… C1 ist
    // Voraussetzung. Bedauerlicherweise …" keeps the reason).
    const start = Math.max(flat.lastIndexOf(". ", m.index) + 2, flat.lastIndexOf("! ", m.index) + 2, 0);
    const endDot = flat.slice(m.index).search(/[.!?](\s|$)/);
    const end = endDot < 0 ? Math.min(flat.length, m.index + 200) : m.index + endDot + 1;
    return { rejection_reason: reason, rejection_detail: flat.slice(start, end).trim().slice(0, 300) };
  }
  return { rejection_reason: "not_given", rejection_detail: null };
}

/**
 * A forwarded email ('Fwd:', 'WG:') would otherwise look like it came from the owner. Returns the
 * original sender, subject and body from the forwarded header block, or null if not forwarded.
 */
export function unforward(subject: string, body: string): { from: string; subject: string; body: string } | null {
  if (!/^\s*(fwd?|wg|fw|weitergeleitet)\s*:/i.test(subject)) return null;
  const m = body.match(
    /(?:-{3,}\s*(?:forwarded message|weitergeleitete nachricht|original message|ursprüngliche nachricht)\s*-{3,}|begin forwarded message:|anfang der weitergeleiteten nachricht:)([\s\S]*)/i,
  );
  if (!m) return null;
  const block = m[1];
  const from = block.match(/^\s*(?:from|von)\s*:\s*(.+)$/im)?.[1]?.trim();
  if (!from) return null;
  const origSubject = block.match(/^\s*(?:subject|betreff)\s*:\s*(.+)$/im)?.[1]?.trim()
    ?? subject.replace(/^\s*(fwd?|wg|fw|weitergeleitet)\s*:\s*/i, "");
  // The original body starts after the header lines (first blank line after 'Subject:'/'Betreff:').
  const after = block.split(/^\s*(?:subject|betreff)\s*:.*$/im)[1] ?? block;
  const origBody = after.replace(/^\s*(?:to|an|cc|date|datum|gesendet|sent)\s*:.*$/gim, "").trim();
  return { from, subject: origSubject, body: origBody };
}

export function atsForDomain(domain: string): string | null {
  const d = domain.toLowerCase();
  for (const [suffix, ats] of Object.entries(ATS_DOMAINS)) {
    if (d === suffix || d.endsWith("." + suffix)) return ats;
  }
  return null;
}

// Subject only: "Einladung zum Interview | Beispiel AG" (a dash is too ambiguous: "… - Firstname
// Lastname" names the candidate; and in the body, footers have "… | Amtsgericht …").
const COMPANY_SUBJECT_SUFFIX = /^[^|]{3,80}\s\|\s*([A-ZÄÖÜ][\w&.\-' ]{1,40}?)\s*$/;
// Subject that starts with a name with a legal form: "Beispielbank Musterstadt eG - Eingangsbestätigung".
const COMPANY_SUBJECT_PREFIX =
  /^(\p{Lu}[\p{L}\p{N}&.\-]+(?: [\p{Lu}&][\p{L}\p{N}&.\-]+){0,4} (?:GmbH & Co\. KG|GmbH|AG|SE|KGaA|KG|eG|mbH|UG|OHG|e\. ?V\.))\s*[-–:|]/u;
const COMPANY_IN_TEXT = [
  // Subject prefix: "Retarus: Your Application confirmation - …", "Beispiel GmbH | Ihre Bewerbung"
  /^([A-ZÄÖÜ][\w&.\-' ]{1,40}?)\s*[:|]\s*(?:your |ihre |deine |re: )?(?:application|bewerbung|eingangsbestätigung)/i,
  /(?:ihre|deine) bewerbung (?:bei|an) (?:der |die |dem )?([A-ZÄÖÜ][\w&.\-' ]{1,60}?)(?:[,.!:\n]| als | für | - | – |$)/,
  /(?:your application (?:to|at|with)|applying (?:to|at)|interest in (?:joining |working at )?)([A-Z][\w&.\-' ]{1,60}?)(?:[,.!:\n]| for | as | - | – |$)/,
];
// A signature line that is only a name with a legal form ("Beispielbank Musterstadt eG"), for HR-system mail
// whose text never says "bei der …" (2026-10-21: a Volksbank rejection via geno.HR was filed under 'geno.').
const COMPANY_SIGNATURE_LINE =
  /^[ \t]*(\p{Lu}[\p{L}\p{N}&.\-]+(?: [\p{Lu}&][\p{L}\p{N}&.\-]+){0,4} (?:GmbH & Co\. KG|GmbH|AG|SE|KGaA|KG|eG|mbH|UG|OHG|e\. ?V\.))[ \t\u3000]*$/mu;

// "… Interesse an einer Beschäftigung bei der Volksbank Mittweida eG": a name with a legal form after
// bei/at, with an optional article. Matched on the text with line breaks flattened (names wrap).
const COMPANY_WITH_LEGAL_FORM =
  /(?:bei|at|with|mit|von|from) (?:der |dem |den |the )?(\p{Lu}[\p{L}\p{N}&.\-]+(?: [\p{Lu}&][\p{L}\p{N}&.\-]+){0,4} (?:GmbH & Co\. KG|GmbH|AG|SE|KGaA|KG|eG|mbH|UG|OHG|e\. ?V\.|Inc\.?|Ltd\.?))(?![\p{L}])/u;
const ROLE_IN_TEXT = [
  // Subject suffix: "… Application confirmation - IT Project Manager (m/f/d)"
  /(?:application|bewerbung)(?: confirmation|sbestätigung|seingang| received| eingegangen)?\s*[-–:|]\s*([^\n]{3,90}?)\s*(?:\(|$)/im,
  /(?:bewerbung|bewerben|beworben)\s+(?:als|für die (?:stelle|position)(?: als)?|auf die (?:stelle|position)(?: als)?)\s+[„"]?([^\n„""",.!?]{3,90}?)[""""]?(?:\s+(?:bei|in|an|\(|-|–)|[,.!?\n]|$)/i,
  /(?:application for|applied for|applying for)\s+(?:the\s+)?(?:position|role|job)?\s*(?:of\s+)?[„"']?([^\n"'„"",.!?]{3,90}?)["'"]?(?:\s+(?:at|in|with|\(|-|–)|[,.!?\n]|$)/i,
  /(?:stelle|position|role|job)\s*:\s*([^\n]{3,90})/i,
];
const REFERENCE = /(?:referenz(?:nummer)?|ref(?:\.|erence)?\s*(?:no\.?|nr\.?|number|id)?|kennziffer|job[- ]?id|stellen[- ]?id|req(?:uisition)?\s*(?:id|no\.?))\s*[:#]?\s*([A-Z0-9][A-Z0-9_\-\/]{2,30})/i;

const DATE_DE = /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/;
const MONTHS: Record<string, number> = {
  jan: 1, januar: 1, january: 1, feb: 2, februar: 2, february: 2, mär: 3, mrz: 3, märz: 3, mar: 3, march: 3,
  apr: 4, april: 4, mai: 5, may: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, oct: 10, october: 10, nov: 11, november: 11,
  dez: 12, dezember: 12, dec: 12, december: 12,
};
const MONTH = "(januar|january|jan|februar|february|feb|märz|march|mär|mrz|mar|april|apr|mai|may|juni|june|jun|juli|july|jul|august|aug|september|sept|sep|oktober|october|okt|oct|november|nov|dezember|december|dez|dec)";
// "14. Oktober 2026", "Di., 14. Okt. 2026", "14 October 2026" / "October 14, 2026" (year optional)
// A month must be a whole word ("jun" not in "junior", "mar" not in "markets").
const DATE_WORDS_DMY = new RegExp(`\\b(\\d{1,2})\\.?\\s*${MONTH}(?![a-zäöü])\\.?,?\\s*(\\d{4})?`, "i");
const DATE_WORDS_MDY = new RegExp(`\\b${MONTH}(?![a-zäöü])\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b,?\\s*(\\d{4})?`, "i");
const DATE_ISO = /\b(20\d{2})-(\d{2})-(\d{2})\b/;
const TIME = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:uhr|h|am|pm)?\b/i;
const TIME_HOUR = /\b([01]?\d|2[0-3])\s*uhr\b/i;   // "um 10 Uhr"

/** "noreply-volksbank-mittweida" → "volksbank mittweida": HR systems often put the employer in the sender's local part. */
function companyFromLocalPart(local: string): string | null {
  const s = local.toLowerCase()
    .replace(/^(no-?reply|do-?not-?reply|bewerbung(en)?|bewerbermanagement|recruiting|jobs?|karriere|careers?|hr|info|mail|system)([-._+]|$)/, "")
    .replace(/[-._+]+/g, " ").replace(/\d+/g, " ").replace(/\s+/g, " ").trim();
  return s.length >= 3 && !NOREPLY_NAMES.test(s) ? s : null;
}

/** The interview's local date and time ('YYYY-MM-DDTHH:MM', Europe/Berlin) from the first text that has
 *  both, with the time searched right after the date first. Year-less dates take the next occurrence. */
export function interviewTime(texts: (string | null | undefined)[], now = new Date()): string | null {
  for (const raw of texts) {
    if (!raw) continue;
    const text = raw.replace(/\s+/g, " ");
    let y: number | null = null, mo = 0, da = 0, end = 0, start = 0;
    const iso = text.match(DATE_ISO), de = text.match(DATE_DE), dmy = text.match(DATE_WORDS_DMY), mdy = text.match(DATE_WORDS_MDY);
    const first = [iso, de, dmy, mdy].filter(Boolean).sort((a, b) => a!.index! - b!.index!)[0];
    if (!first) continue;
    if (first === iso) [y, mo, da] = [Number(iso![1]), Number(iso![2]), Number(iso![3])];
    else if (first === de) [da, mo, y] = [Number(de![1]), Number(de![2]), Number(de![3].length === 2 ? "20" + de![3] : de![3])];
    else if (first === dmy) [da, mo, y] = [Number(dmy![1]), MONTHS[dmy![2].toLowerCase()], dmy![3] ? Number(dmy![3]) : null];
    else [mo, da, y] = [MONTHS[mdy![1].toLowerCase()], Number(mdy![2]), mdy![3] ? Number(mdy![3]) : null];
    start = first.index!; end = start + first[0].length;
    if (!(mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) continue;
    if (y === null) {
      y = now.getFullYear();
      if (new Date(y, mo - 1, da) < new Date(now.getFullYear(), now.getMonth(), now.getDate())) y += 1;
    }
    // The time: right after the date ("…2026, 10:00 Uhr", "… um 14.30"), else anywhere but inside the date.
    const after = text.slice(end, end + 60), rest = text.slice(0, start) + " " + text.slice(end);
    const hourOnly = (s: string) => { const m = s.match(TIME_HOUR); return m ? [m[0], m[1], "00"] as unknown as RegExpMatchArray : null; };
    const t = after.match(TIME) ?? hourOnly(after) ?? rest.match(TIME) ?? hourOnly(rest);
    if (!t) continue;
    let h = Number(t[1]);
    if (/pm/i.test(t[0]) && h < 12) h += 12;
    if (/am/i.test(t[0]) && h === 12) h = 0;
    return `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}T${String(h).padStart(2, "0")}:${t[2]}`;
  }
  return null;
}

/** DTSTART of the first event in a calendar invite (.ics), as Europe/Berlin local time. A TZID is taken
 *  as German local time (interviews here; Microsoft writes 'W. Europe Standard Time'); 'Z' is UTC. */
export function icsStart(ics: string | null | undefined): string | null {
  if (!ics) return null;
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const m = unfolded.match(/^DTSTART(;[^:\n]*)?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?/m);
  if (!m) return null;
  const [, , y, mo, d, h, mi, , z] = m;
  if (!z) return `${y}-${mo}-${d}T${h}:${mi}`;
  return berlinLocal(new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi)));
}

/** A moment as Europe/Berlin wall time 'YYYY-MM-DDTHH:MM'. */
export function berlinLocal(at: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Europe/Berlin wall time 'YYYY-MM-DDTHH:MM' as a UTC ISO timestamp (handles summer time). */
export function berlinToUtc(local: string): string {
  const [d, t] = local.split("T");
  const [y, mo, da] = d.split("-").map(Number), [h, mi] = t.split(":").map(Number);
  let guess = Date.UTC(y, mo - 1, da, h, mi);
  for (let i = 0; i < 2; i++) {             // shift by the difference between the wall time and the guess
    const shown = berlinLocal(new Date(guess));
    const [sd, st] = shown.split("T");
    const [sy, smo, sda] = sd.split("-").map(Number), [sh, smi] = st.split(":").map(Number);
    guess += Date.UTC(y, mo - 1, da, h, mi) - Date.UTC(sy, smo - 1, sda, sh, smi);
  }
  return new Date(guess).toISOString();
}

export function extractFields(fromName: string, fromDomain: string, subject: string, body: string, fromLocal = ""): Extracted {
  const text = `${subject}\n${body.slice(0, 6000)}`;
  // Company names wrap across lines in plain-text mail ("bei \nder Volksbank"): a flattened copy.
  const flat = `${subject}\n${body.slice(0, 6000).replace(/[ \t]*\r?\n[ \t]*/g, " ")}`;
  const ats = atsForDomain(fromDomain);

  let company: string | null = (subject.match(COMPANY_SUBJECT_SUFFIX) ?? subject.match(COMPANY_SUBJECT_PREFIX))?.[1].trim() ?? null;
  for (const re of company ? [] : COMPANY_IN_TEXT) {
    const m = text.match(re);
    if (m) {
      company = m[1].trim();
      break;
    }
  }
  // A name with a legal form: in the subject first (precise); the body only after the display name,
  // since footers name courts and registers ("Amtsgericht …").
  if (!company) company = subject.match(COMPANY_WITH_LEGAL_FORM)?.[1].trim() ?? null;
  // From an HR system, the display name is often the system's own ("geno.", "CHECK IN"): the body's
  // name with a legal form goes first.
  if (!company && ats) company = flat.match(COMPANY_WITH_LEGAL_FORM)?.[1].trim() ?? null;
  if (!company && ats) company = body.slice(0, 6000).match(COMPANY_SIGNATURE_LINE)?.[1].trim() ?? null;
  const name = fromName.replace(/["']/g, "").trim();
  // "Anna Muster" <anna.muster@beispiel.de> is a person writing, not the company's name: two or more
  // name words, all in a first.last / first_last address.
  const words = name.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").split(/\s+/).filter((w) => w.length > 1);
  const personal = words.length >= 2 && /^[a-z]+([._][a-z]+)+$/i.test(fromLocal) &&
    words.every((w) => fromLocal.toLowerCase().split(/[._]/).includes(w));
  if (!company && name && !personal && !NOREPLY_NAMES.test(name) && !/@/.test(name)) {
    // "Beispiel Daten GmbH Recruiting" / "Talent Team at Beispiel" → the company part
    company = name.replace(/\b(recruiting|recruitment|careers?|karriere|talent( acquisition)?( team)?|hr|team|jobs)\b/gi, "")
      .replace(/\b(at|bei|von|from)\b/gi, "").replace(/[|·•\-–]+/g, " ").replace(/\s+/g, " ").trim() || null;
  }
  if (!company) company = flat.match(COMPANY_WITH_LEGAL_FORM)?.[1].trim() ?? null;
  if (!company && ats && fromLocal) company = companyFromLocalPart(fromLocal);
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

  const interview_at = interviewTime([body]);
  return { company, role_title: role, reference_number: ref, interview_at, ats };
}
