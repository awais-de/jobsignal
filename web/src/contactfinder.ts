// Outreach helpers: who to ping after applying, and the ping itself. Pure functions, no network.
// Contacts come only from what the system already holds (the job ad), what the owner exports
// (LinkedIn connections CSV) or types in. LinkedIn pages are never fetched (spec 11.5): search
// links are opened by the owner.

export type ContactType = "recruiter" | "hiring_manager" | "team_member" | "referral" | "other";

export type AdContact = {
  name: string | null;       // null: a team inbox (jobs@…) without a person
  email: string | null;
  phone: string | null;
  role: string | null;
  type: ContactType;
};

// -- company names -----------------------------------------------------------------------
const LEGAL = /\b(gmbh|ag|se|kg|kgaa|ug|ohg|gbr|e\.?v|inc|ltd|llc|bv|sa|plc|co|corp|& co|mbh|holding|group|gruppe)\b\.?/g;
export const normCompany = (s: string) =>
  s.toLowerCase().replace(LEGAL, " ").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();

/** Same employer? Exact after normalising, or one name contained in the other as whole words. */
export function sameCompany(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = normCompany(a), y = normCompany(b);
  if (x.length < 3 || y.length < 3) return false;
  return x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

// -- contacts in a job ad --------------------------------------------------------------------
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;
const PHONE = /(?:\+49|\(0|0)[\d\s/()-]{6,}\d/;
const GENERIC_LOCAL = /(^|[-._])(jobs?|careers?|karriere|recruit(ing|ment)?|bewerbung(en)?|hr|personal|info|talent|people|application|apply|personalabteilung|stellen|team)([-._\d]|$)/i;
// Addresses that are never a hiring contact.
const IGNORE_LOCAL = /publicrelations|presse|press|marketing|datenschutz|privacy|dsb|support|noreply|no-reply|webmaster|kontakt$|contact$/i;
const PART = String.raw`[A-ZÄÖÜ][\p{Ll}']+(?:-[A-ZÄÖÜ][\p{Ll}']+)?`;
const NAME = String.raw`(?:Dr\.\s|Prof\.\s)?${PART}(?: ${PART}){1,2}`;
// A name right after a cue word: "Ansprechpartnerin: Frau Anna Muster", "Recruiterin Anna Muster",
// "Recruiterinnen Anna Muster und Berta Beispiel", "Herr Max Muster".
const CUE = new RegExp(
  String.raw`(?:Ansprechpartner(?:in|\*in|:in)?|Recruiter(?:in|innen|\*innen|:innen)?|Kontakt(?:person)?|Contact(?: person)?|Herr|Frau|Mr\.?|Ms\.?|Mrs\.?)` +
  String.raw`[:\s]+(?:(?:Frau|Herr)\s+)?(${NAME})(?:\s+(?:und|and|&)\s+(?:(?:Frau|Herr)\s+)?(${NAME}))?`, "gu");
const RECRUITER_HINT = /recruit|talent|personal|\bhr\b|human resources|bewerbung|people/i;
const MANAGER_HINT = /leiter|leitung|lead\b|head of|manager|teamleit|bereichs|director|cto|ceo|founder|gründer|geschäftsführ/i;
const NOT_NAMES = new Set(["human resources", "talent acquisition", "people team", "recruiting team"]);

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
const foldDe = (s: string) => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
const looksLikeName = (s: string) =>
  !s.includes("@") && !NOT_NAMES.has(s.toLowerCase()) && new RegExp(`^${NAME}$`, "u").test(s.trim());

function emailFor(name: string, emails: string[]): string | null {
  const last = name.replace(/^(Dr\.|Prof\.)\s+/, "").split(/\s+/).pop()!;
  const keys = new Set([fold(last), foldDe(last)].map((k) => k.replace(/[^a-z]/g, "")).filter((k) => k.length >= 3));
  return emails.find((e) => [...keys].some((k) => e.split("@")[0].toLowerCase().replace(/[^a-z]/g, "").includes(k))) ?? null;
}

/** "anna.muster@x.de" → "Anna Muster" (only for first.last style addresses). */
function nameFromEmail(email: string): string | null {
  const parts = email.split("@")[0].split(/[._]/).filter(Boolean);
  if (parts.length !== 2 || parts.some((p) => p.length < 2 || /\d/.test(p))) return null;
  return parts.map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}

function roleNear(text: string, at: number, name: string): { role: string | null; type: ContactType } {
  const before = text.slice(Math.max(0, at - 90), at);
  const after = text.slice(at + name.length, at + name.length + 120);
  // "Moritz Muster, Bereichsleiter Künstliche Intelligenz, ..." → the phrase after the comma.
  const m = after.match(/^\s*[,(–-]\s*([A-ZÄÖÜ][^,;:()\n]{2,60}?)\s*[,;:)\n]/u);
  const phrase = m && !EMAIL.test(m[1]) && !/\d{3}/.test(m[1]) ? m[1].trim() : null;
  EMAIL.lastIndex = 0;
  const near = `${before} ${phrase ?? ""}`;
  if (RECRUITER_HINT.test(phrase ?? "") || (!phrase && RECRUITER_HINT.test(before))) {
    return { role: phrase ?? "Recruiting", type: "recruiter" };
  }
  if (MANAGER_HINT.test(near)) return { role: phrase, type: "hiring_manager" };
  if (/team\b/i.test(before.slice(-40)) || /^\s*team\b/i.test(after)) {
    const team = (before + name + after).match(/Team [A-Z][\w &-]{2,40}/);
    return { role: team ? team[0] : phrase, type: "hiring_manager" };
  }
  return { role: phrase, type: RECRUITER_HINT.test(near) ? "recruiter" : "other" };
}

export function contactsFromAd(description: string | null, namedContact: string | null): AdContact[] {
  const text = (description ?? "").replace(/\]\(mailto:[^)]*\)/g, "]").replace(/https?:\/\/mailto:/g, "");
  const emails = [...new Set((text.match(EMAIL) ?? []).map((e) => e.replace(/[.,;]+$/, "")))];
  const people = new Map<string, AdContact>();

  const add = (name: string, at: number) => {
    const key = fold(name);
    if (people.has(key) || !looksLikeName(name)) return;
    const { role, type } = at >= 0 ? roleNear(text, at, name) : { role: null, type: "other" as ContactType };
    const phone = at >= 0 ? text.slice(at, at + 220).match(PHONE)?.[0].trim() ?? null : null;
    people.set(key, { name, email: emailFor(name, emails), phone, role, type });
  };

  for (const m of text.matchAll(CUE)) {
    add(m[1], text.indexOf(m[1], m.index));
    if (m[2]) add(m[2], text.indexOf(m[2], m.index));
  }
  if (namedContact && looksLikeName(namedContact)) add(namedContact.trim(), text.indexOf(namedContact.trim()));

  // Addresses not tied to a person found above: a person's own address (first.last@) or a team inbox.
  const used = new Set([...people.values()].map((p) => p.email).filter(Boolean));
  const extra: AdContact[] = [];
  for (const e of emails) {
    const local = e.split("@")[0];
    if (used.has(e) || IGNORE_LOCAL.test(local)) continue;
    const generic = GENERIC_LOCAL.test(local);
    const name = generic ? null : nameFromEmail(e);
    if (name && people.has(fold(name))) continue;
    if (name) {
      // The person behind first.last@ is usually named in the text too: take the role from there.
      const at = text.search(new RegExp(name.replace(/ /g, "\\s+"), "i"));
      const { role, type } = at >= 0 ? roleNear(text, at, name) : { role: null, type: "other" as ContactType };
      const phone = at >= 0 ? text.slice(at, at + 220).match(PHONE)?.[0].trim() ?? null : null;
      extra.push({ name, email: e, phone, role, type });
    } else {
      extra.push({ name: null, email: e, phone: null, role: "Team inbox", type: "recruiter" });
    }
  }
  return [...people.values(), ...extra];
}

export const isPersonalEmail = (e: string | null) => !!e && !GENERIC_LOCAL.test(e.split("@")[0]);

// -- the ping ----------------------------------------------------------------------------------
/** "Data Engineer (m/w/d)" → "Data Engineer"; gender tags and asterisks removed. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\((?:[mwfdxi]\s*[/|,]\s*){1,3}[mwfdxi]\)|\((?:all genders?|alle geschlechter|gn\*?|w\*m\*d|m\/w\/d|f\/m\/d|m\/f\/x)\)/gi, "")
    .replace(/\*(?=\s|\/|$)/g, "")
    .replace(/\s{2,}/g, " ").replace(/\s+([/,)])/g, "$1").trim();
}

export const firstName = (full: string) => full.replace(/^(Dr\.|Prof\.)\s+/, "").split(/\s+/)[0];

/** German if the ad reads German (rough stop-word count). */
export function adLanguage(text: string | null): "de" | "en" {
  const t = ` ${(text ?? "").toLowerCase()} `;
  const de = (t.match(/ (und|der|die|das|wir|sie|für|mit|ihre|eine) /g) ?? []).length;
  const en = (t.match(/ (and|the|we|you|for|with|your|our) /g) ?? []).length;
  return de > en ? "de" : "en";
}

export function pingText(o: {
  name: string | null; sender: string; position: string; company: string; lang: "de" | "en"; applied: boolean;
}): string {
  const pos = cleanTitle(o.position);
  if (!o.applied) {
    // Before applying: interest plus a question, not "I applied".
    if (o.lang === "de") {
      return `${o.name ? `Hallo ${o.name}` : "Hallo"}, ich bin ${o.sender} und interessiere mich sehr für die Stelle ${pos} bei ${o.company}. ` +
        `Bevor ich mich bewerbe, hätte ich eine kurze Frage zur Rolle und zum Team. Hätten Sie kurz Zeit? Viele Grüße, ${o.sender}`;
    }
    return `${o.name ? `Hi ${firstName(o.name)}` : "Hi"}, I'm ${o.sender} and I'm very interested in the ${pos} role at ${o.company}. ` +
      `Before I apply, I'd love to ask a quick question about the role and the team. Would you have a moment? Best regards, ${o.sender}`;
  }
  if (o.lang === "de") {
    return `${o.name ? `Hallo ${o.name}` : "Hallo"}, ich bin ${o.sender} und habe mich gerade auf die Stelle ${pos} bei ${o.company} beworben. ` +
      `Ich wollte mich kurz persönlich vorstellen. Bei Fragen zu meiner Bewerbung stehe ich gern zur Verfügung. Viele Grüße, ${o.sender}`;
  }
  return `${o.name ? `Hi ${firstName(o.name)}` : "Hi"}, I'm ${o.sender} and I just applied for the ${pos} role at ${o.company}. ` +
    `I wanted to briefly introduce myself, and I'm happy to answer any questions about my application. Best regards, ${o.sender}`;
}

/** LinkedIn's limit for a note on a connection request (VERIFY: has been 300 characters). */
export const LINKEDIN_NOTE_LIMIT = 300;

export const linkedinSearch = (keywords: string) =>
  `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;

// -- LinkedIn connections export -----------------------------------------------------------------
export type Connection = {
  full_name: string; linkedin_url: string | null; email: string | null;
  company_name: string | null; role_title: string | null; connected_on: string | null;
};

/** RFC-4180-ish CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
                                         jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

/** LinkedIn's Connections.csv: a few "Notes:" lines, then a header row starting with "First Name". */
export function parseConnections(text: string): Connection[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const h = rows.findIndex((r) => r[0]?.trim() === "First Name");
  if (h < 0) throw new Error("This doesn't look like LinkedIn's Connections.csv (no 'First Name' header).");
  const col = (name: string) => rows[h].findIndex((c) => c.trim().toLowerCase() === name);
  const [fn, ln, url, em, co, pos, on] =
    ["first name", "last name", "url", "email address", "company", "position", "connected on"].map(col);
  const v = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() || null : null);
  const date = (s: string | null) => {
    const m = s?.match(/^(\d{1,2}) (\w{3}) (\d{4})$/);
    return m && MONTHS[m[2].toLowerCase()] ? `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, "0")}` : null;
  };
  return rows.slice(h + 1)
    .map((r) => ({
      full_name: [v(r, fn), v(r, ln)].filter(Boolean).join(" "),
      linkedin_url: v(r, url), email: v(r, em), company_name: v(r, co), role_title: v(r, pos), connected_on: date(v(r, on)),
    }))
    .filter((c) => c.full_name);
}
