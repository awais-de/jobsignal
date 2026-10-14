// CV formats and the generator's output (owner decision 2026-10-14). An uploaded LaTeX file is read for
// its format only: the preamble (all macros) verbatim, the header's layout (where the name, headline,
// location and contact items go, the separator, the link style), each section's title, order and style,
// which rows sit inside which rows section (e.g. "Sprachen" inside "Kenntnisse") and the date style.
// The content comes from the master CV through a per-job draft; renderTex writes the draft in the format.
// Pure functions, no network.

import { escapeTex, parseCv, readArg, texChars, type ParsedCV } from "./cvtex";
import {
  bulletText, entryHead, joinText, rowOf, SECTIONS, sectionSpec, tr,
  type DateStyle, type Item, type Lang, type Style,
} from "./cvschema";

// -- plain text with marks <-> LaTeX ----------------------------------------------------------------
/** Replaces every \name{a}{b}… (nargs arguments) with fn(args). */
function replaceCmd(s: string, name: string, nargs: number, fn: (args: string[]) => string): string {
  const re = new RegExp(`\\\\${name}(?![A-Za-z])`, "g");
  let out = "", last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    let i = m.index + m[0].length;
    const args: string[] = [];
    try {
      for (let k = 0; k < nargs; k++) {
        while (s[i] === " ") i++;
        if (s[i] !== "{") throw new Error("no argument");
        const [a, next] = readArg(s, i);
        args.push(a); i = next;
      }
    } catch { continue; }
    out += s.slice(last, m.index) + fn(args);
    last = i; re.lastIndex = i;
  }
  return out + s.slice(last);
}

/** LaTeX to the master CV's plain text: links become [text](url), bold **x**, other commands go. */
export function texToMark(tex: string): string {
  let s = tex.replace(/(^|[^\\])%[^\n]*/g, "$1").replace(/\s*\n\s*/g, " ").trim();
  s = replaceCmd(s, "href", 2, ([u, t]) => `[${texToMark(t)}](${u.replace(/\\([%#&_])/g, "$1")})`);
  s = replaceCmd(s, "textbf", 1, ([x]) => `**${texToMark(x)}**`);
  for (const c of ["underline", "textit", "emph", "textsc", "texttt", "mbox", "text"]) s = replaceCmd(s, c, 1, ([x]) => texToMark(x));
  s = texChars(s);
  return s.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?\s?/g, "").replace(/[{}]/g, "").replace(/\s{2,}/g, " ").trim();
}

const urlTex = (u: string) => u.trim().replace(/([%#])/g, "\\$1");
/** Plain text with marks to LaTeX: everything escaped, [text](url) a link, **x** bold. */
export function markToTex(md: string): string {
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*/g;
  let out = "", i = 0;
  for (const m of md.matchAll(re)) {
    out += escapeTex(md.slice(i, m.index));
    out += m[1] !== undefined ? `\\href{${urlTex(m[2])}}{${markToTex(m[1])}}` : `\\textbf{${markToTex(m[3])}}`;
    i = m.index! + m[0].length;
  }
  return (out + escapeTex(md.slice(i))).replace(/\s*\n\s*/g, " ").trim();
}
/** Marks removed: for the keyword check and the plain-text copy. */
export const markToPlain = (md: string) => md.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1").replace(/\*\*(.+?)\*\*/g, "$1");

// -- the format ------------------------------------------------------------------------------------
export type FormatSection = {
  key: string; title: string; style: Style;
  rows: string[];        // rows sections: what they hold, in order: "own" (own records or skills) or a placed section's key
};
export type Contact = { text: string; url: string };
export type CvFormat = {
  lang: Lang;
  preamble: string;
  header: { tpl: string; sep: string; linkTpl: string; contacts: boolean };
  sections: FormatSection[];
  styles: { textPre: string; textPost: string; rowsOpen: string; rowsClose: string; context: boolean };
  date: DateStyle;
  found: { name: string; headline: string; location: string; contacts: Contact[] };   // the file's header values (for the import)
  skipped: string[];                                                                  // sections not recognised: left out
  parsed: ParsedCV;
};

const SEP = /~?\$\\vert\$~?|\$\|\$|\\textbar(?:\{\})?|\\quad\\textbullet\\quad|\\textbullet/;

function detectHeader(header: string) {
  const found: CvFormat["found"] = { name: "", headline: "", location: "", contacts: [] };
  let tpl = header;
  const nm = tpl.match(/(\{\\(?:Huge|huge|LARGE)\s*(?:\\scshape\s*|\\bfseries\s*|\\textbf\{)*)([^{}\\]+?)(\s*\}+)/);
  if (!nm) throw new Error("The header's name ({\\Huge …}) wasn't found.");
  found.name = texToMark(nm[2]);
  tpl = tpl.replace(nm[0], `${nm[1]}@@NAME@@${nm[3]}`);

  const hl = tpl.match(/\{\\large\s+/);
  if (hl) {
    const [inner, next] = readArg(tpl, hl.index!);
    found.headline = texToMark(inner.replace(/^\\large\s+/, ""));
    tpl = `${tpl.slice(0, hl.index!)}{\\large @@HEADLINE@@}${tpl.slice(next)}`;
  }

  const lines = tpl.split("\n");
  const sepLines = lines.map((l, i) => (SEP.test(l.replace(/(^|[^\\])%.*$/, "$1")) ? i : -1)).filter((i) => i >= 0);
  let sep = "~$\\vert$~", linkTpl = "\\href{@@URL@@}{@@TEXT@@}", contacts = false;
  if (sepLines.length) {
    const start = sepLines[0];
    let end = sepLines[sepLines.length - 1];
    if (SEP.test(lines[end].trim().slice(-12)) && end + 1 < lines.length) end++;
    const block = lines.slice(start, end + 1).join("\n");
    sep = block.match(SEP)![0];
    found.contacts = block.split(SEP).map((s) => s.trim()).filter(Boolean).map((item) => {
      const href = item.match(/\\href\{([^}]*)\}\{([\s\S]*)\}\s*$/);
      if (!href) return { text: texToMark(item), url: "" };
      if (/\\underline\{/.test(href[2])) linkTpl = "\\href{@@URL@@}{\\underline{@@TEXT@@}}";
      return { text: texToMark(href[2]), url: href[1].replace(/\\([%#])/g, "$1") };
    });
    contacts = true;
    // The location: a text line of its own just above the contacts ("Berlin, Deutschland \\[3pt]").
    let prev = start - 1;
    while (prev >= 0 && !lines[prev].trim()) prev--;
    const loc = prev >= 0 ? lines[prev].match(/^(\s*)([^\\%@{}][^%@]*?)(\s*\\\\(\[[^\]]*\])?\s*)$/) : null;
    lines.splice(start, end - start + 1, "@@CONTACTS@@");
    if (loc) { found.location = texToMark(loc[2]); lines[prev] = `${loc[1]}@@LOCATION@@${loc[3]}`; }
  }
  return { tpl: lines.filter((l) => !/^\s*%/.test(l)).join("\n"), sep, linkTpl, contacts, found };
}

function detectDates(cv: ParsedCV, lang: Lang): DateStyle {
  const all = cv.sections.flatMap((s) => (s.kind === "entries" ? s.entries.flatMap((e) => e.args.map((a) => texChars(a.tex))) : [])).join("\n");
  const month: DateStyle["month"] = /\b\d{2}\/\d{4}\b/.test(all) ? "MM/YYYY" : /\b\d{2}\.\d{4}\b/.test(all) ? "MM.YYYY"
    : /\b(jan|feb|mar|mär|apr|may|mai|jun|jul|aug|sep|oct|okt|nov|dec|dez)[a-zä.]*\s+\d{4}/i.test(all) ? "MMM YYYY" : "MM/YYYY";
  const sepM = all.match(/\d{4}\s*(–|—|-|bis)\s*(?=\d|[A-Za-zÄÖÜäöü])/);
  const present = all.match(/\b(heute|present|aktuell|today|now|jetzt|current)\b/i)?.[0] ?? (lang === "de" ? "heute" : "Present");
  return { month, sep: sepM ? ` ${sepM[1]} ` : " – ", present };
}

const sectionKeyOf = (title: string) => SECTIONS.find((s) => s.match.test(title.trim()))?.key ?? null;
const joinableKeyOf = (label: string) => SECTIONS.find((s) => s.joinable && s.match.test(label.replace(/:\s*$/, "").trim()))?.key ?? null;

export function detectFormat(tex: string, lang: Lang): CvFormat {
  const cv = parseCv(tex);
  if (!/\\newcommand\{?\\resumeSubheading\}?/.test(cv.preamble)) throw new Error("This format has no \\resumeSubheading command, so entries can't be written.");
  const head = detectHeader(cv.header);
  const sections: FormatSection[] = [];
  const skipped: string[] = [];
  const styles: CvFormat["styles"] = {
    textPre: "\\small", textPost: "\\normalsize",
    rowsOpen: "\\begin{itemize}[leftmargin=0.15in, label={}, itemsep=1pt, topsep=2pt]\n  \\small", rowsClose: "\\end{itemize}",
    context: /\\newcommand\{?\\resumeContext\}?/.test(cv.preamble),
  };
  let textSeen = false, rowsSeen = false;
  for (const s of cv.sections) {
    const key = sectionKeyOf(s.title);
    if (!key || sections.some((x) => x.key === key)) { skipped.push(s.title); continue; }
    const spec = sectionSpec(key)!;
    const style: Style = s.kind === "paragraph" ? "text" : s.kind === "rows" ? "rows" : s.kind === "entries" ? "entries" : spec.style;
    const rows: string[] = [];
    if (s.kind === "paragraph" && !textSeen) { textSeen = true; styles.textPre = s.pre || styles.textPre; styles.textPost = s.post || styles.textPost; }
    if (s.kind === "rows") {
      if (!rowsSeen) { rowsSeen = true; styles.rowsOpen = s.open; styles.rowsClose = s.close; }
      for (const r of s.rows) {
        const placed = joinableKeyOf(texToMark(r.label.tex));
        const what = placed && placed !== key ? placed : "own";
        if (!rows.includes(what)) rows.push(what);
      }
    }
    sections.push({ key, title: texToMark(s.title), style, rows });
  }
  return {
    lang, preamble: cv.preamble, header: { tpl: head.tpl, sep: head.sep, linkTpl: head.linkTpl, contacts: head.contacts },
    sections, styles, date: detectDates(cv, lang), found: head.found, skipped, parsed: cv,
  };
}

/** Where a section placed into a rows section sits, per the format ("languages" → "skills"). */
export function placementsOf(f: CvFormat): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of f.sections) for (const r of s.rows) if (r !== "own") out[r] = s.key;
  return out;
}

// -- the master CV, indexed --------------------------------------------------------------------------
export type Master = {
  items: Item[];
  byId: Map<string, Item>;
  children: (id: string) => Item[];
  /** The records a section offers in the generator (roles for experience, flattened across companies). */
  roots: (section: string) => Item[];
  header: Item | undefined;
  /** Achievements linked to a record (offered as its bullets). */
  linked: (id: string) => Item[];
};
export function indexMaster(items: Item[]): Master {
  const byId = new Map(items.map((i) => [i.id, i]));
  const kids = new Map<string, Item[]>();
  for (const i of items) if (i.parent_id) kids.set(i.parent_id, [...(kids.get(i.parent_id) ?? []), i]);
  for (const list of kids.values()) list.sort((a, b) => a.sort - b.sort);
  const top = (section: string) => items.filter((i) => i.section === section && !i.parent_id).sort((a, b) => a.sort - b.sort);
  return {
    items, byId, header: items.find((i) => i.section === "header"),
    children: (id) => kids.get(id) ?? [],
    roots: (section) => (section === "experience" ? top(section).flatMap((c) => kids.get(c.id) ?? []).filter((r) => r.kind === "role") : top(section)),
    linked: (id) => items.filter((i) => i.kind === "achievement" && i.data.link === id),
  };
}

// -- the generator's draft (saved per job and format; never written back to the master) ----------------
export type DBullet = { src?: string; text: string };
export type DEntry = { src: string | null; on: boolean; slots: string[]; context: string; bullets: DBullet[]; picked: string[] };
export type DRow = { src: string; label: string; text: string };   // src: item:<id> | section:<key> | skills:<category> | custom:<n>
export type DSection = {
  key: string; on: boolean; title: string; style: Style;
  into: string | null;        // joinable sections: written as one row of this rows section
  text: string; bullets: DBullet[]; entries: DEntry[]; rows: DRow[];
  picked: string[];           // ticked item ids (joined mode) or skill ids (skills)
};
export type DHeader = { name: string; headline: string; location: string; contacts: (Contact & { on: boolean })[] };
export type CvDraft = { v: 1; header: DHeader; sections: DSection[] };

export type SkillGroup = { cat: string; label: string; items: { id: string; name: string; on: boolean; asked?: boolean }[]; order?: number };

// Copy-on-tick (owner decision R2): ticking copies a text into the editable one; unticking removes it again.
export const appendPart = (text: string, part: string, sep = ", ") => (text.trim() ? `${text.trim()}${sep}${part}` : part);
export function removePart(text: string, part: string, sep = ", "): string {
  const parts = text.split(sep.trim()).map((p) => p.trim());
  const i = parts.indexOf(part.trim());
  if (i < 0) return text;
  parts.splice(i, 1);
  return parts.filter(Boolean).join(sep);
}

const emptySection = (key: string, title: string, style: Style): DSection =>
  ({ key, on: false, title, style, into: null, text: "", bullets: [], entries: [], rows: [], picked: [] });

export function newEntry(item: Item, m: Master, f: CvFormat, on: boolean): DEntry {
  const head = entryHead(item, item.parent_id ? m.byId.get(item.parent_id) : undefined, f.date, f.lang);
  return { src: item.id, on, slots: head.slots, context: head.context, bullets: [], picked: [] };
}

/** The first draft for a job: the format's sections on, in its order; the rest off at the end. */
export function initialDraft(f: CvFormat, m: Master, skills: SkillGroup[]): CvDraft {
  const lang = f.lang;
  const h = m.header?.data ?? {};
  const contacts = (Array.isArray(h.contacts) ? h.contacts as Contact[] : f.found.contacts).map((c) => ({ text: c.text, url: c.url, on: true }));
  const header: DHeader = {
    name: tr(h.name, lang) || f.found.name, headline: tr(h.headline, lang), location: tr(h.location, lang), contacts,
  };
  const placed = placementsOf(f);
  const order = [...f.sections.map((s) => s.key)];
  if (!order.includes("highlights")) order.splice(order.includes("summary") ? order.indexOf("summary") + 1 : 0, 0, "highlights");
  for (const s of SECTIONS) if (!order.includes(s.key)) order.push(s.key);

  const sections = order.map((key) => {
    const spec = sectionSpec(key)!;
    const fs = f.sections.find((s) => s.key === key);
    const d = emptySection(key, fs?.title ?? spec.title[lang], fs?.style ?? spec.style);
    d.on = !!fs || key === "highlights" || !!placed[key];
    d.into = placed[key] ?? null;
    if (d.into) d.picked = m.roots(key).map((i) => i.id);
    if (d.style === "entries") d.entries = m.roots(key).map((i) => newEntry(i, m, f, !!fs && (key === "experience" || key === "education")));
    return d;
  });
  // Rows: the format's order of own rows and placed sections.
  for (const d of sections) {
    if (d.style !== "rows") continue;
    const fs = f.sections.find((s) => s.key === d.key);
    const what = fs?.rows.length ? [...fs.rows] : ["own"];
    if (!what.includes("own")) what.push("own");
    for (const w of what) {
      if (w === "own") {
        if (d.key === "skills") {
          for (const g of skills) d.rows.push({ src: `skills:${g.cat}`, label: g.label, text: g.items.filter((i) => i.on).map((i) => i.name).join(", ") });
          d.picked = skills.flatMap((g) => g.items.filter((i) => i.on).map((i) => i.id));
        } else if (fs) {
          for (const i of m.roots(d.key)) { const r = rowOf(i, lang); d.rows.push({ src: `item:${i.id}`, ...r }); }
        }
      } else {
        const src = sections.find((s) => s.key === w)!;
        d.rows.push({ src: `section:${w}`, label: src.title, text: src.picked.map((id) => joinText(m.byId.get(id)!, lang)).filter(Boolean).join(", ") });
      }
    }
  }
  return { v: 1, header, sections };
}

/** A saved draft after the master changed: new records are offered (unticked), new sections added (off). */
export function reconcile(d: CvDraft, f: CvFormat, m: Master): CvDraft {
  const sections = d.sections.map((s) => {
    if (s.style !== "entries") return s;
    const have = new Set(s.entries.map((e) => e.src));
    const fresh = m.roots(s.key).filter((i) => !have.has(i.id)).map((i) => newEntry(i, m, f, false));
    return fresh.length ? { ...s, entries: [...s.entries, ...fresh] } : s;
  });
  for (const spec of SECTIONS) if (!sections.some((s) => s.key === spec.key)) {
    const s = emptySection(spec.key, spec.title[f.lang], spec.style);
    if (s.style === "entries") s.entries = m.roots(spec.key).map((i) => newEntry(i, m, f, false));
    sections.push(s);
  }
  return { ...d, sections };
}

/** The bullet sources of an entry: its children and the achievements linked to it. */
export function entrySources(e: DEntry, m: Master): Item[] {
  if (!e.src) return [];
  return [...m.children(e.src), ...m.linked(e.src)];
}
export { bulletText };

// -- writing ---------------------------------------------------------------------------------------
const visibleRows = (s: DSection, d: CvDraft) => s.rows.filter((r) => {
  if (r.src.startsWith("section:")) { const p = d.sections.find((x) => x.key === r.src.slice(8)); if (!p?.on || p.into !== s.key) return false; }
  return r.text.trim() || r.label.trim();
});

export function renderTex(f: CvFormat, d: CvDraft): string {
  const h = d.header;
  const contacts = h.contacts.filter((c) => c.on && (c.text.trim() || c.url.trim()))
    .map((c) => (c.url.trim() ? f.header.linkTpl.replace("@@URL@@", urlTex(c.url)).replace("@@TEXT@@", markToTex(c.text || c.url)) : markToTex(c.text)));
  let header = f.header.tpl.replace("@@NAME@@", markToTex(h.name));
  const dropLine = (s: string, token: string) => s.split("\n").filter((l) => !l.includes(token)).join("\n");
  header = h.headline.trim() ? header.replace("@@HEADLINE@@", markToTex(h.headline)) : dropLine(header, "@@HEADLINE@@");
  header = h.location.trim() ? header.replace("@@LOCATION@@", markToTex(h.location)) : dropLine(header, "@@LOCATION@@");
  header = contacts.length ? header.replace("@@CONTACTS@@", contacts.join(` ${f.header.sep}\n`)) : dropLine(header, "@@CONTACTS@@");

  const out: string[] = [f.preamble, "", header.trim()];
  for (const s of d.sections) {
    if (!s.on || s.into) continue;
    const block: string[] = [];
    if (s.style === "text") {
      if (!s.text.trim()) continue;
      block.push(...[f.styles.textPre, markToTex(s.text), f.styles.textPost].filter(Boolean));
    } else if (s.style === "bullets") {
      const items = s.bullets.map((b) => b.text.trim()).filter(Boolean);
      if (!items.length) continue;
      block.push("\\resumeItemListStart", ...items.map((t) => `  \\resumeItem{${markToTex(t)}}`), "\\resumeItemListEnd");
    } else if (s.style === "entries") {
      const entries = s.entries.filter((e) => e.on);
      if (!entries.length) continue;
      block.push("\\resumeSubHeadingListStart");
      for (const e of entries) {
        const a = [0, 1, 2, 3].map((k) => markToTex(e.slots[k] ?? ""));
        block.push("", "  \\resumeSubheading", `    {${a[0]}}{${a[1]}}`, `    {${a[2]}}{${a[3]}}`);
        if (f.styles.context && e.context.trim()) block.push(`  \\resumeContext{${markToTex(e.context)}}`);
        const items = e.bullets.map((b) => b.text.trim()).filter(Boolean);
        // An empty itemize is a LaTeX error: no list without bullets. The blank line is the template's spacing.
        if (items.length) block.push("", "  \\resumeItemListStart", ...items.map((t) => `    \\resumeItem{${markToTex(t)}}`), "  \\resumeItemListEnd");
      }
      block.push("", "\\resumeSubHeadingListEnd");
    } else {
      const rows = visibleRows(s, d);
      if (!rows.length) continue;
      block.push(f.styles.rowsOpen);
      for (const r of rows) block.push(r.label.trim() ? `  \\item \\textbf{${markToTex(r.label.trim().replace(/:$/, ""))}:} ${markToTex(r.text)}` : `  \\item ${markToTex(r.text)}`);
      block.push(f.styles.rowsClose);
    }
    out.push("", `\\section{${escapeTex(s.title)}}`, ...block);
  }
  out.push("", "\\end{document}", "");
  return out.join("\n");
}

/** The CV as plain text: for the keyword check, the prompts and the resume record. */
export function plainText(d: CvDraft): string {
  const p = (s: string) => markToPlain(s).trim();
  const out: string[] = [p(d.header.name), p(d.header.headline), p(d.header.location)].filter(Boolean);
  for (const s of d.sections) {
    if (!s.on || s.into) continue;
    const lines: string[] = [];
    if (s.style === "text" && s.text.trim()) lines.push(p(s.text));
    if (s.style === "bullets") lines.push(...s.bullets.filter((b) => b.text.trim()).map((b) => `- ${p(b.text)}`));
    if (s.style === "entries") for (const e of s.entries.filter((e) => e.on)) {
      lines.push(e.slots.map(p).filter(Boolean).join(" · "));
      if (e.context.trim()) lines.push(p(e.context));
      lines.push(...e.bullets.filter((b) => b.text.trim()).map((b) => `- ${p(b.text)}`));
    }
    if (s.style === "rows") lines.push(...visibleRows(s, d).map((r) => `${p(r.label)}${r.label.trim() ? ": " : ""}${p(r.text)}`));
    if (lines.length) out.push("", s.title, ...lines);
  }
  return out.join("\n").replace(/\u202F|\u00A0/g, " ");
}
