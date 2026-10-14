// Master CV schema (owner decision 2026-10-14): which sections exist, which records and fields each has,
// and how a record becomes CV text. Every text is stored in German and English ({de, en}); dates, links
// and grades are language-neutral. Texts are plain, with two marks: [text](url) for a link, **x** for bold.

export type Lang = "de" | "en";
export type L = { de?: string; en?: string };

export type Item = {
  id: string; section: string; kind: string; parent_id: string | null; sort: number;
  data: Record<string, unknown>;
};
export const ITEM_COLUMNS = "id,section,kind,parent_id,sort,data";

export type FieldType = "text" | "long" | "plain" | "url" | "date" | "bool" | "ref";
export type FieldSpec = { key: string; label: string; type: FieldType; hint?: string };
export type KindSpec = { kind: string; label: string; fields: FieldSpec[]; children?: string[] };

/** How a section is written: a paragraph, a bullet list, entries (heading + bullets) or labelled rows. */
export type Style = "text" | "bullets" | "entries" | "rows";

export type SectionSpec = {
  key: string;
  title: Record<Lang, string>;
  style: Style;
  kinds: KindSpec[];                     // the first one is the section's record; the others are children
  match: RegExp;                         // section titles (and row labels) in an uploaded format
  joinable?: boolean;                    // can be written as one row inside a rows section ("Sprachen: …")
  slots?: string[];                      // entries: what the four heading fields hold
  help?: string;
};

const T = (key: string, label: string, hint?: string): FieldSpec => ({ key, label, type: "text", hint });
const LONG = (key: string, label: string, hint?: string): FieldSpec => ({ key, label, type: "long", hint });
const DATES: FieldSpec[] = [
  { key: "start", label: "From", type: "date", hint: "2023-11 or 2016" },
  { key: "end", label: "To", type: "date", hint: "empty when current" },
  { key: "current", label: "Ongoing", type: "bool" },
  T("date_note", "Date note", "e.g. (voraussichtlich) / (expected)"),
];
const BULLET: KindSpec = { kind: "bullet", label: "Bullet", fields: [LONG("text", "Text")] };

export const SECTIONS: SectionSpec[] = [
  {
    key: "summary", title: { de: "Profil", en: "Profile" }, style: "text",
    match: /^(profil|profile|summary|kurzprofil|über mich|about me)/i,
    kinds: [{ kind: "snippet", label: "Summary version", fields: [{ key: "label", label: "Name", type: "plain", hint: "e.g. data engineering" }, LONG("text", "Text")] }],
    help: "Tailored per CV. Keep a few versions here as starting points; the generator starts blank.",
  },
  {
    key: "highlights", title: { de: "Kernqualifikationen", en: "Key Qualifications" }, style: "bullets",
    match: /^(kernqualifikation|key qualification|highlights|qualifikationsprofil)/i,
    kinds: [{ kind: "snippet", label: "Reusable highlight", fields: [LONG("text", "Text")] }],
    help: "Written per job: 2–3 bullets that answer the posting's top requirements with your evidence. Reusable ones can live here.",
  },
  {
    key: "skills", title: { de: "Kenntnisse", en: "Skills" }, style: "rows",
    match: /^(kenntnisse|skills|fähigkeiten|faehigkeiten|kompetenzen|technolog|expertise)/i, kinds: [],
    help: "Comes from the skills database (Me → Skills).",
  },
  {
    key: "experience", title: { de: "Berufserfahrung", en: "Work Experience" }, style: "entries",
    match: /^(berufserfahrung|berufliche|erfahrung|experience|work|employment)/i,
    slots: ["Company", "Dates", "Role", "Location"],
    kinds: [
      { kind: "company", label: "Company", fields: [T("name", "Company"), T("location", "Location", "Berlin, Deutschland / Berlin, Germany"), { key: "url", label: "Website", type: "url" }], children: ["role"] },
      { kind: "role", label: "Role", fields: [T("title", "Title"), ...DATES, T("location", "Location (if not the company's)"), LONG("context", "Context line", "the grey line under the heading (optional)")], children: ["bullet"] },
      BULLET,
    ],
  },
  {
    key: "projects", title: { de: "Projekte", en: "Projects" }, style: "entries",
    match: /^(projekt|project)/i, slots: ["Title", "Dates", "Link", "Tech / note"],
    kinds: [
      { kind: "project", label: "Project", fields: [T("title", "Title"), ...DATES, { key: "url", label: "Link", type: "url" }, { key: "url_text", label: "Link text", type: "plain", hint: "github.com/…" }, T("tech", "Tech / note"), { key: "link", label: "Belongs to", type: "ref" }, LONG("context", "Context line")], children: ["bullet"] },
      BULLET,
    ],
  },
  {
    key: "education", title: { de: "Ausbildung", en: "Education" }, style: "entries",
    match: /^(ausbildung|bildung|studium|education|academic)/i, slots: ["Institution", "Dates", "Degree", "Location"],
    kinds: [
      { kind: "education", label: "Education", fields: [T("institution", "Institution"), T("degree", "Degree"), ...DATES, T("location", "Location"), T("grade", "Grade", "Note: 1,9 / CGPA: 3.6/4.0"), LONG("context", "Context line")], children: ["course", "thesis", "bullet"] },
      { kind: "course", label: "Relevant course", fields: [T("name", "Course")] },
      { kind: "thesis", label: "Thesis", fields: [T("title", "Title"), LONG("text", "Description")] },
      BULLET,
    ],
  },
  {
    key: "certifications", title: { de: "Zertifizierungen", en: "Certifications" }, style: "entries", joinable: true,
    match: /^(zertifi|certif)/i, slots: ["Name", "Date", "Issuer", "Link"],
    kinds: [
      { kind: "certification", label: "Certification", fields: [T("name", "Name"), T("issuer", "Issuer"), { key: "date", label: "Date", type: "date", hint: "2024-05" }, { key: "url", label: "Credential link", type: "url" }], children: ["bullet"] },
      BULLET,
    ],
  },
  {
    key: "achievements", title: { de: "Auszeichnungen", en: "Achievements" }, style: "bullets", joinable: true,
    match: /^(auszeichnung|erfolge|achievement|award|honou?r)/i,
    kinds: [{ kind: "achievement", label: "Achievement", fields: [T("title", "Title"), LONG("description", "Description"), { key: "date", label: "Date", type: "date" }, { key: "link", label: "Belongs to", type: "ref", hint: "a role or an education, or nothing" }] }],
    help: "Linked to a role or education, it's also offered as a bullet there.",
  },
  {
    key: "research", title: { de: "Forschungsinteressen", en: "Research Interests" }, style: "rows", joinable: true,
    match: /^(forschung|research)/i,
    kinds: [{ kind: "interest", label: "Research interest", fields: [T("title", "Topic"), LONG("description", "Description")] }],
  },
  {
    key: "publications", title: { de: "Publikationen", en: "Publications" }, style: "entries",
    match: /^(publikation|veröffentlichung|publication)/i, slots: ["Title", "Year", "Venue", "Link"],
    kinds: [{ kind: "publication", label: "Publication", fields: [T("title", "Title"), T("venue", "Venue"), { key: "year", label: "Year", type: "plain" }, { key: "authors", label: "Authors", type: "plain" }, { key: "url", label: "Link", type: "url" }] }],
  },
  {
    key: "volunteering", title: { de: "Ehrenamt", en: "Volunteering" }, style: "entries",
    match: /^(ehrenamt|engagement|volunt)/i, slots: ["Organisation", "Dates", "Role", "Location"],
    kinds: [
      { kind: "volunteering", label: "Volunteering", fields: [T("org", "Organisation"), T("role", "Role"), ...DATES, T("location", "Location")], children: ["bullet"] },
      BULLET,
    ],
  },
  {
    key: "languages", title: { de: "Sprachen", en: "Languages" }, style: "rows", joinable: true,
    match: /^(sprachen|languages)/i,
    kinds: [{ kind: "language", label: "Language", fields: [T("language", "Language"), T("level", "Level", "C1 / Muttersprache / native")] }],
  },
  {
    key: "hobbies", title: { de: "Interessen", en: "Interests" }, style: "rows", joinable: true,
    match: /^(hobb|interessen|freizeit|interests)/i,
    kinds: [{ kind: "hobby", label: "Hobby / interest", fields: [T("title", "Title"), T("description", "Description (optional)")] }],
  },
  {
    key: "personal", title: { de: "Persönliche Angaben", en: "Personal Details" }, style: "rows",
    match: /^(persönlich|persoenlich|personal)/i,
    kinds: [{ kind: "detail", label: "Detail", fields: [T("label", "Label", "Geburtsdatum / Nationality / Work permit"), T("value", "Value")] }],
  },
  {
    key: "additional", title: { de: "Weitere Angaben", en: "Additional Information" }, style: "rows",
    match: /^(weitere|sonstige|additional|other|misc)/i,
    kinds: [{ kind: "info", label: "Entry", fields: [T("label", "Label", "Führerschein / Mobilität"), T("text", "Text", "Klasse B")] }],
  },
];
export const sectionSpec = (key: string) => SECTIONS.find((s) => s.key === key);
export const kindSpec = (section: string, kind: string) => sectionSpec(section)?.kinds.find((k) => k.kind === kind);

// -- reading values ------------------------------------------------------------------------------
/** A bilingual field in one language, falling back to the other (marked so the UI can show it). */
export function tr(v: unknown, lang: Lang): string {
  if (typeof v === "string") return v;
  const o = (v ?? {}) as L;
  return (o[lang] ?? "").trim() || (o[lang === "de" ? "en" : "de"] ?? "").trim();
}
export const plainOf = (v: unknown) => (typeof v === "string" ? v : "");

export type DateStyle = { month: "MM/YYYY" | "MM.YYYY" | "MMM YYYY"; sep: string; present: string };
const MONTHS: Record<Lang, string[]> = {
  de: ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sep.", "Okt.", "Nov.", "Dez."],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
};
export function fmtDate(d: string, style: DateStyle, lang: Lang): string {
  const m = d.match(/^(\d{4})-(\d{2})$/);
  if (!m) return d;
  if (style.month === "MMM YYYY") return `${MONTHS[lang][Number(m[2]) - 1]} ${m[1]}`;
  return `${m[2]}${style.month === "MM.YYYY" ? "." : "/"}${m[1]}`;
}
export function fmtRange(data: Record<string, unknown>, style: DateStyle, lang: Lang): string {
  const s = plainOf(data.start), e = plainOf(data.end), note = tr(data.date_note, lang);
  let out = s ? fmtDate(s, style, lang) : "";
  if (s && (e || data.current)) out += `${style.sep}${data.current ? style.present : fmtDate(e, style, lang)}`;
  else if (!s && e) out = fmtDate(e, style, lang);
  return [out, note].filter(Boolean).join(" ");
}

const link = (url: string, text: string) => (url ? `[${text || url.replace(/^https?:\/\/(www\.)?/, "")}](${url})` : "");

/** The four heading fields and the context line of an entry record (parent: the company of a role). */
export function entryHead(item: Item, parent: Item | undefined, style: DateStyle, lang: Lang): { slots: string[]; context: string } {
  const d = item.data, p = parent?.data ?? {};
  const ctx = tr(d.context, lang);
  switch (item.kind) {
    case "role":
      return { slots: [tr(p.name, lang), fmtRange(d, style, lang), tr(d.title, lang), tr(d.location, lang) || tr(p.location, lang)], context: ctx };
    case "education": {
      const grade = tr(d.grade, lang);
      return { slots: [tr(d.institution, lang), fmtRange(d, style, lang), tr(d.degree, lang) + (grade ? ` (${grade})` : ""), tr(d.location, lang)], context: ctx };
    }
    case "project":
      return { slots: [tr(d.title, lang), fmtRange(d, style, lang), link(plainOf(d.url), plainOf(d.url_text)), tr(d.tech, lang)], context: ctx };
    case "certification":
      return { slots: [tr(d.name, lang), plainOf(d.date) ? fmtDate(plainOf(d.date), style, lang) : "", tr(d.issuer, lang), link(plainOf(d.url), "")], context: "" };
    case "publication":
      return { slots: [tr(d.title, lang), plainOf(d.year), tr(d.venue, lang), link(plainOf(d.url), "")], context: plainOf(d.authors) };
    case "volunteering":
      return { slots: [tr(d.org, lang), fmtRange(d, style, lang), tr(d.role, lang), tr(d.location, lang)], context: "" };
    default:
      return { slots: ["", "", "", ""], context: "" };
  }
}

const COURSES: Record<Lang, string> = { de: "Relevante Kurse", en: "Relevant courses" };
const THESIS: Record<Lang, string> = { de: "Abschlussarbeit", en: "Thesis" };
export const coursesPrefix = (lang: Lang) => `${COURSES[lang]}: `;

/** A child record (or a linked achievement) as bullet text. */
export function bulletText(item: Item, lang: Lang): string {
  const d = item.data;
  if (item.kind === "thesis") return `${THESIS[lang]}: ${[tr(d.title, lang), tr(d.text, lang)].filter(Boolean).join(" – ")}`;
  if (item.kind === "course") return tr(d.name, lang);
  if (item.kind === "achievement") return achievementText(item, lang);
  return tr(d.text, lang);
}
export function achievementText(item: Item, lang: Lang): string {
  const t = tr(item.data.title, lang), desc = tr(item.data.description, lang);
  return t && desc ? `**${t}**: ${desc}` : t || desc;
}

/** A record as a labelled row ("Führerschein: Klasse B"). */
export function rowOf(item: Item, lang: Lang): { label: string; text: string } {
  const d = item.data;
  switch (item.kind) {
    case "info": return { label: tr(d.label, lang), text: tr(d.text, lang) };
    case "detail": return { label: tr(d.label, lang), text: tr(d.value, lang) };
    case "language": return { label: tr(d.language, lang), text: tr(d.level, lang) };
    case "interest": return { label: tr(d.title, lang), text: tr(d.description, lang) };
    case "hobby": return { label: tr(d.title, lang), text: tr(d.description, lang) };
    default: return { label: "", text: joinText(item, lang) };
  }
}

/** A record as one part of a joined row ("Deutsch (C1)", a certification's name, …). */
export function joinText(item: Item, lang: Lang): string {
  const d = item.data;
  switch (item.kind) {
    case "language": { const lv = tr(d.level, lang); return tr(d.language, lang) + (lv ? ` (${lv})` : ""); }
    case "certification": return tr(d.name, lang);
    case "hobby": return tr(d.title, lang);
    case "interest": return tr(d.title, lang);
    case "achievement": return tr(d.title, lang);
    default: return rowOf(item, lang).text;
  }
}

/** A short name for a record in lists and pickers. */
export function itemLabel(item: Item, parent?: Item): string {
  const d = item.data;
  const pick = (...keys: string[]) => keys.map((k) => tr(d[k], "en") || tr(d[k], "de")).find(Boolean) ?? "";
  if (item.kind === "role") return [pick("title"), parent ? tr(parent.data.name, "en") : ""].filter(Boolean).join(" · ") || "Role";
  if (item.kind === "education") return [pick("degree"), pick("institution")].filter(Boolean).join(" · ") || "Education";
  return pick("name", "title", "label", "language", "org", "text") || kindSpec(item.section, item.kind)?.label || item.kind;
}
