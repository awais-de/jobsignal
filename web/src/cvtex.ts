// LaTeX reading helpers for CV formats (owner decision 2026-10-14: the uploaded LaTeX is the format; the
// content is the master CV). Pure functions, no network.
//
// Known structures in an uploaded file:
//   - a paragraph section (Profil/Profile): one text
//   - an itemize of "\item \textbf{Label:} text" rows (Kenntnisse, Weitere Angaben)
//   - \resumeSubheading entries with an optional \resumeContext and \resumeItem bullets
// Anything else is reported and left out.

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
  header: string;                   // between \begin{document} and the first \section
  headerBefore: string; headline: Field | null; headerAfter: string;
  name: string | null;
  sections: Section[];
};

// -- LaTeX <-> plain text -------------------------------------------------------------------------
const UMLAUT: Record<string, string> = { '\\"a': "ä", '\\"o': "ö", '\\"u': "ü", '\\"A': "Ä", '\\"O': "Ö", '\\"U': "Ü", "\\ss": "ß", "\\ss{}": "ß" };
const NNBSP = "\u202F";          // narrow no-break space <-> \,

/** LaTeX character commands to characters: umlauts, escapes, \, ~ and dashes. */
export function texChars(tex: string): string {
  let s = tex.replace(/\s*\n\s*/g, " ").trim();
  for (const [k, v] of Object.entries(UMLAUT)) s = s.split(k).join(v);
  return s.replace(/\\"\{(\w)\}/g, (_, c) => UMLAUT[`\\"${c}`] ?? c)
    .replace(/\\([&%$#_{}])/g, "$1").replace(/\\,/g, NNBSP).replace(/~/g, "\u00A0")
    .replace(/---/g, "—").replace(/--/g, "–");
}

export function toPlain(tex: string): Field {
  const s = texChars(tex);
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

// -- reading -------------------------------------------------------------------------------------
/** The brace-balanced argument starting at `i` (which must be '{'); returns [content, index after]. */
export function readArg(s: string, i: number): [string, number] {
  let depth = 0, j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return [s.slice(i + 1, j), j + 1]; }
  }
  throw new Error("Unbalanced braces in the LaTeX.");
}
export const skipSpace = (s: string, i: number) => {
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
  return { preamble, header, headerBefore, headline, headerAfter, name, sections };
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
