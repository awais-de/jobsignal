// CV builder: read a base CV written in the owner's LaTeX format into sections and fields, and write a
// tailored version back. Pure functions, no network.
//
// The uploaded base file is also the layout: its preamble and header are kept verbatim, so a new base
// version with layout changes carries them over. Known structures become editable:
//   - a paragraph section (Profil/Profile): one text
//   - an itemize of "\item \textbf{Label:} text" rows (Kenntnisse, Weitere Angaben)
//   - \resumeSubheading entries with an optional \resumeContext and \resumeItem bullets
// Anything else is kept as it is. A field the owner didn't edit is written back exactly as uploaded.

export type Field = { tex: string; plain: string; simple: boolean };   // simple: editable as plain text
export type Bullet = { id: string; field: Field };
export type Entry = { id: string; args: Field[]; context: Field | null; bullets: Bullet[]; extra: string };
export type Row = { id: string; label: Field; text: Field };
export type Section =
  | { id: string; kind: "paragraph"; title: string; pre: string; text: Field; post: string }
  | { id: string; kind: "rows"; title: string; open: string; rows: Row[]; close: string }
  | { id: string; kind: "entries"; title: string; entries: Entry[]; projects: boolean }
  | { id: string; kind: "raw"; title: string; body: string };
export type ParsedCV = {
  preamble: string;                 // up to and including \begin{document}
  headerBefore: string; headline: Field | null; headerAfter: string;
  name: string | null;
  sections: Section[];
};

/** What the owner changed for one job. Keys are field ids; nothing here is written back to the base. */
export type Draft = {
  headline?: string;
  text: Record<string, string>;        // paragraph / row / bullet / entry-field id -> edited text
  on: Record<string, boolean>;          // bullet / row / entry id -> included
  extra: Record<string, string[]>;      // entry id -> bullets added for this job
};
export const emptyDraft = (): Draft => ({ text: {}, on: {}, extra: {} });

// -- LaTeX <-> plain text -------------------------------------------------------------------------
const UMLAUT: Record<string, string> = { '\\"a': "ä", '\\"o': "ö", '\\"u': "ü", '\\"A': "Ä", '\\"O': "Ö", '\\"U': "Ü", "\\ss": "ß", "\\ss{}": "ß" };
const NNBSP = "\u202F";          // narrow no-break space <-> \,

export function toPlain(tex: string): Field {
  let s = tex.replace(/\s*\n\s*/g, " ").trim();
  for (const [k, v] of Object.entries(UMLAUT)) s = s.split(k).join(v);
  s = s.replace(/\\"\{(\w)\}/g, (_, c) => UMLAUT[`\\"${c}`] ?? c)
    .replace(/\\([&%$#_{}])/g, "$1").replace(/\\,/g, NNBSP).replace(/~/g, "\u00A0")
    .replace(/---/g, "—").replace(/--/g, "–");
  // Still a command or a group? Then it is edited as LaTeX (links, bold, …), not as plain text.
  const simple = !/[\\{}]/.test(s.replace(/[&%$#_]/g, ""));
  return { tex: tex.trim(), plain: simple ? s : tex.replace(/\s*\n\s*/g, " ").trim(), simple };
}

export function escapeTex(plain: string): string {
  return plain
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(new RegExp(NNBSP, "g"), "\\,").replace(/\u00A0/g, "~")
    .replace(/—/g, "---").replace(/–/g, "--");
}

/** A field's LaTeX: the original when unchanged, else the edit (escaped when the field is plain text). */
export function fieldTex(f: Field, edited: string | undefined): string {
  if (edited === undefined || edited === f.plain) return f.tex;
  return f.simple ? escapeTex(edited) : edited;
}

// -- reading -------------------------------------------------------------------------------------
/** The brace-balanced argument starting at `i` (which must be '{'); returns [content, index after]. */
function readArg(s: string, i: number): [string, number] {
  let depth = 0, j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return [s.slice(i + 1, j), j + 1]; }
  }
  throw new Error("Unbalanced braces in the LaTeX.");
}
const skipSpace = (s: string, i: number) => {
  while (i < s.length) {
    if (/\s/.test(s[i])) i++;
    else if (s[i] === "%") { while (i < s.length && s[i] !== "\n") i++; }
    else break;
  }
  return i;
};
const stripComments = (s: string) => s.split("\n").filter((l) => !/^\s*%/.test(l)).join("\n");

function parseEntries(id: string, body: string, projects: boolean): Section | null {
  const entries: Entry[] = [];
  const marks = [...body.matchAll(/\\resumeSubheading\b/g)].map((m) => m.index!);
  if (!marks.length) return null;
  marks.forEach((at, n) => {
    let i = at + "\\resumeSubheading".length;
    const args: Field[] = [];
    for (let k = 0; k < 4; k++) {
      i = skipSpace(body, i);
      if (body[i] !== "{") throw new Error("A \\resumeSubheading needs four {…} arguments.");
      const [a, next] = readArg(body, i);
      args.push(toPlain(a));
      i = next;
    }
    const end = n + 1 < marks.length ? marks[n + 1] : body.indexOf("\\resumeSubHeadingListEnd") >= 0 ? body.lastIndexOf("\\resumeSubHeadingListEnd") : body.length;
    const rest = body.slice(i, end);
    const eid = `${id}.e${n}`;
    let context: Field | null = null;
    const ctx = rest.indexOf("\\resumeContext");
    if (ctx >= 0) context = toPlain(readArg(rest, skipSpace(rest, ctx + "\\resumeContext".length))[0]);
    const bullets: Bullet[] = [];
    let b = 0;
    for (const m of rest.matchAll(/\\resumeItem(?![A-Za-z])/g)) {
      const [t] = readArg(rest, skipSpace(rest, m.index! + "\\resumeItem".length));
      bullets.push({ id: `${eid}.b${b++}`, field: toPlain(t) });
    }
    // Whatever else the entry had (e.g. \vspace{2pt}) is kept.
    const extra = stripComments(rest
      .replace(/\\resumeContext\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "")
      .replace(/\\resumeItemListStart[\s\S]*?\\resumeItemListEnd/g, "")).trim();
    entries.push({ id: eid, args, context, bullets, extra });
  });
  return { id, kind: "entries", title: "", entries, projects };
}

function parseRows(id: string, body: string): Section | null {
  const m = body.match(/(\\begin\{itemize\}(?:\[[^\]]*\])?\s*(?:\\small)?)([\s\S]*?)(\\end\{itemize\})/);
  if (!m || !/\\item\s*\\textbf\{/.test(m[2])) return null;
  const rows: Row[] = [];
  m[2].split(/\\item(?![A-Za-z])/).slice(1).forEach((chunk, n) => {
    const t = chunk.indexOf("\\textbf");
    if (t < 0) return;
    const [label, after] = readArg(chunk, skipSpace(chunk, t + "\\textbf".length));
    rows.push({ id: `${id}.r${n}`, label: toPlain(label), text: toPlain(stripComments(chunk.slice(after))) });
  });
  return rows.length ? { id, kind: "rows", title: "", open: m[1].trim(), rows, close: m[3] } : null;
}

export function parseCv(tex: string): ParsedCV {
  const begin = tex.indexOf("\\begin{document}");
  const finish = tex.lastIndexOf("\\end{document}");
  if (begin < 0 || finish < 0) throw new Error("This isn't a full LaTeX document (\\begin{document} … \\end{document}).");
  const preamble = tex.slice(0, begin + "\\begin{document}".length);
  const body = tex.slice(begin + "\\begin{document}".length, finish);
  const firstSection = body.search(/\\section\*?\{/);
  const header = firstSection >= 0 ? body.slice(0, firstSection) : body;

  // Header: the headline is the first {\large …}; the name the {\Huge … } group.
  let headline: Field | null = null, headerBefore = header, headerAfter = "";
  const hl = header.match(/\{\\large\s+/);
  if (hl) {
    const start = hl.index!;
    const [inner, next] = readArg(header, start);
    headline = toPlain(inner.replace(/^\\large\s+/, ""));
    headerBefore = header.slice(0, start);
    headerAfter = header.slice(next);
  }
  const nameM = header.match(/\{\\Huge\s*(?:\\scshape\s*)?([^{}]+)\}/);
  const name = nameM ? nameM[1].trim() : null;

  const sections: Section[] = [];
  const parts = firstSection >= 0 ? body.slice(firstSection).split(/(?=\\section\*?\{)/) : [];
  parts.forEach((part, n) => {
    const tm = part.match(/^\\section\*?\{([^}]*)\}/);
    const title = tm ? tm[1] : "";
    const raw = part.slice(tm ? tm[0].length : 0);
    const content = stripComments(raw).trim();
    const id = `s${n}`;
    const projects = /projekt|project/i.test(title);
    const parsed = parseEntries(id, content, projects) ?? parseRows(id, content);
    if (parsed) { sections.push({ ...parsed, title } as Section); return; }
    if (content && !/\\(begin|item)\b/.test(content)) {
      const pre = (content.match(/^(\\(small|footnotesize|normalsize)\s*)+/) ?? [""])[0];
      const post = (content.match(/(\s*\\(normalsize|small)\s*)+$/) ?? [""])[0];
      const text = content.slice(pre.length, content.length - post.length);
      sections.push({ id, kind: "paragraph", title, pre: pre.trim(), text: toPlain(text), post: post.trim() });
      return;
    }
    sections.push({ id, kind: "raw", title, body: content });
  });
  return { preamble, headerBefore, headline, headerAfter, name, sections };
}

// -- skills section from the skills database (owner decision 2026-10-14) ------------------------------
/** Rows built from the skills database replace the skill rows of the master CV's skills section; rows of
 *  that section that aren't skills (e.g. "Sprachen") stay from the master CV, on by default. */
export type DbSkills = { sectionId: string; rows: { label: string; items: string[] }[] };
const SKILLS_TITLE = /kenntnisse|skills|fähigkeiten|faehigkeiten|kompetenzen|technolog|expertise/i;
const KEEP_ROW = /sprach|language/i;

/** The id of the master CV's skills section: the first labelled-rows section with a skills-like title. */
export function skillsSectionId(cv: ParsedCV): string | null {
  return cv.sections.find((s) => s.kind === "rows" && SKILLS_TITLE.test(s.title))?.id ?? null;
}
/** In the database-driven section, a master-CV row is on by default only when it isn't a skill row. */
const rowOnIn = (r: Row, d: Draft, db?: DbSkills, sectionId?: string) =>
  db && db.sectionId === sectionId ? d.on[r.id] ?? KEEP_ROW.test(r.label.plain) : rowOn(r, d);
export const masterRowOn = (r: Row, d: Draft, sectionId: string, db: DbSkills | undefined) => rowOnIn(r, d, db, sectionId);

// -- writing --------------------------------------------------------------------------------------
/** Bullets start off; entries are on, except in a projects section (on once one of its bullets is). */
export function entryOn(e: Entry, s: Section & { kind: "entries" }, d: Draft): boolean {
  if (d.on[e.id] !== undefined) return d.on[e.id];
  return !s.projects || e.bullets.some((b) => d.on[b.id]) || (d.extra[e.id] ?? []).some((t) => t.trim());
}
export const rowOn = (r: Row, d: Draft) => d.on[r.id] ?? true;

export function renderCv(cv: ParsedCV, d: Draft, db?: DbSkills): string {
  const out: string[] = [cv.preamble, ""];
  out.push(cv.headline
    ? `${cv.headerBefore}{\\large ${fieldTex(cv.headline, d.headline)}}${cv.headerAfter}`.trimEnd()
    : cv.headerBefore.trimEnd());
  for (const s of cv.sections) {
    const block: string[] = [];
    if (s.kind === "paragraph") {
      block.push(...[s.pre, fieldTex(s.text, d.text[s.id]), s.post].filter(Boolean));
    } else if (s.kind === "rows") {
      const rows = s.rows.filter((r) => rowOnIn(r, d, db, s.id));
      const generated = db && db.sectionId === s.id ? db.rows.filter((r) => r.items.length) : [];
      if (!rows.length && !generated.length) continue;
      block.push(s.open);
      for (const g of generated) block.push(`  \\item \\textbf{${escapeTex(g.label)}:} ${g.items.map(escapeTex).join(", ")}`);
      for (const r of rows) block.push(`  \\item \\textbf{${fieldTex(r.label, d.text[`${r.id}.label`])}} ${fieldTex(r.text, d.text[r.id])}`);
      block.push(s.close);
    } else if (s.kind === "entries") {
      const entries = s.entries.filter((e) => entryOn(e, s, d));
      if (!entries.length) continue;
      block.push("\\resumeSubHeadingListStart");
      for (const e of entries) {
        const a = e.args.map((f, k) => fieldTex(f, d.text[`${e.id}.a${k}`]));
        block.push("", "  \\resumeSubheading", `    {${a[0]}}{${a[1]}}`, `    {${a[2]}}{${a[3]}}`);
        if (e.context) block.push(`  \\resumeContext{${fieldTex(e.context, d.text[`${e.id}.ctx`])}}`);
        const items = [
          ...e.bullets.filter((b) => d.on[b.id]).map((b) => fieldTex(b.field, d.text[b.id])),
          ...(d.extra[e.id] ?? []).map((t) => t.trim()).filter(Boolean).map(escapeTex),
        ];
        // An empty itemize is a LaTeX error: no list when no bullet is on.
        // The blank line before the list is a paragraph break in LaTeX: it is the template's spacing.
        if (items.length) block.push("", "  \\resumeItemListStart", ...items.map((t) => `    \\resumeItem{${t}}`), "  \\resumeItemListEnd");
        if (e.extra) block.push(`  ${e.extra}`);
      }
      block.push("", "\\resumeSubHeadingListEnd");
    } else {
      if (!s.body.trim()) continue;
      block.push(s.body);
    }
    out.push("", `\\section{${s.title}}`, ...block);
  }
  out.push("", "\\end{document}", "");
  return out.join("\n");
}

/** The CV as plain text: for the keyword check, the prompts and the resume record. */
export function plainCv(cv: ParsedCV, d: Draft, db?: DbSkills): string {
  const plain = (f: Field, edited?: string) => (edited !== undefined ? edited : f.plain).replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, "").replace(/[{}]/g, "");
  const out: string[] = [];
  if (cv.name) out.push(cv.name);
  if (cv.headline) out.push(plain(cv.headline, d.headline));
  for (const s of cv.sections) {
    if (s.kind === "paragraph") out.push("", s.title, plain(s.text, d.text[s.id]));
    else if (s.kind === "rows") {
      const rows = s.rows.filter((r) => rowOnIn(r, d, db, s.id));
      const generated = db && db.sectionId === s.id ? db.rows.filter((r) => r.items.length) : [];
      if (rows.length || generated.length) {
        out.push("", s.title, ...generated.map((g) => `${g.label}: ${g.items.join(", ")}`),
                 ...rows.map((r) => `${plain(r.label, d.text[`${r.id}.label`])} ${plain(r.text, d.text[r.id])}`));
      }
    } else if (s.kind === "entries") {
      const entries = s.entries.filter((e) => entryOn(e, s, d));
      if (!entries.length) continue;
      out.push("", s.title);
      for (const e of entries) {
        out.push(e.args.map((f, k) => plain(f, d.text[`${e.id}.a${k}`])).filter(Boolean).join(" · "));
        if (e.context) out.push(plain(e.context, d.text[`${e.id}.ctx`]));
        for (const b of e.bullets.filter((b) => d.on[b.id])) out.push(`- ${plain(b.field, d.text[b.id])}`);
        for (const t of (d.extra[e.id] ?? []).filter((t) => t.trim())) out.push(`- ${t.trim()}`);
      }
    }
  }
  return out.join("\n").replace(/\u202F|\u00A0/g, " ");
}

/** "Lebenslauf_Anna_Muster_Beispiel_AG.pdf" / "CV_Anna_Muster_Beispiel_AG.pdf": a name for the portal upload. */
export function cvFileName(lang: "de" | "en", name: string | null, company: string): string {
  const clean = (s: string) => s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/Ä/g, "Ae").replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue").replace(/ß/g, "ss").normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/\(.*?\)/g, " ").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const who = clean(name ?? "") || "Name";
  const co = clean(company).split("_").slice(0, 4).join("_");
  return `${lang === "de" ? "Lebenslauf" : "CV"}_${who}${co ? `_${co}` : ""}.pdf`;
}
