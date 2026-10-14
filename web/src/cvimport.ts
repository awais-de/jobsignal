// One-time import (owner decision 2026-10-14): a full CV in LaTeX fills the master CV, in its language.
// Importing the other language afterwards fills the empty side of the matching records (same company,
// same position in the list) and never overwrites what is there. Pure function: returns the changes.

import { type CvFormat, texToMark } from "./cvformat";
import { type Item, type L, type Lang, SECTIONS } from "./cvschema";

export type ImportPlan = { inserts: Item[]; updates: { id: string; data: Record<string, unknown> }[]; report: string[] };

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, " ").trim();
const sectionKeyOf = (title: string) => SECTIONS.find((s) => s.match.test(title.trim()))?.key ?? null;
const joinableKeyOf = (label: string) => SECTIONS.find((s) => s.joinable && s.match.test(label.replace(/:\s*$/, "").trim()))?.key ?? null;

/** "11/2023 – 06/2024", "2016 – 2020", "01/2023 – heute", "10/2024 – 02/2027 (voraussichtlich)", "Nov 2023 – Present". */
const MONTH_NAMES = ["jan", "feb", "m(?:a|ä)r", "apr", "ma[iy]", "jun", "jul", "aug", "sep", "o[ck]t", "nov", "de[cz]"];
function oneDate(s: string): string | null {
  let m = s.match(/^(\d{1,2})[/.](\d{4})$/);
  if (m) return `${m[2]}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{4})$/);
  if (m) return m[1];
  m = s.match(/^([A-Za-zÄÖÜäöü]+)\.?\s+(\d{4})$/);
  if (m) { const i = MONTH_NAMES.findIndex((n) => new RegExp(`^${n}`, "i").test(m![1])); if (i >= 0) return `${m[2]}-${String(i + 1).padStart(2, "0")}`; }
  return null;
}
export function parseRange(text: string): { start?: string; end?: string; current?: boolean; note?: string } {
  const t = text.replace(/ /g, " ").trim();
  if (!t) return {};
  const noteM = t.match(/\s*(\(.*\))\s*$/);
  const core = noteM ? t.slice(0, noteM.index).trim() : t;
  const note = noteM?.[1];
  const parts = core.split(/\s*(?:–|—|-|bis)\s*/);
  const start = oneDate(parts[0] ?? "");
  if (!start) return { note: t };
  if (parts.length === 1) return { start, note };
  if (/^(heute|present|aktuell|today|now|jetzt|current)$/i.test(parts[1] ?? "")) return { start, current: true, note };
  const end = oneDate(parts[1] ?? "");
  return end ? { start, end, note } : { start, note: t };
}

/** Splits "Deutsch (C1), Englisch (C2), Urdu" on commas outside parentheses. */
function splitList(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const c of s) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if ((c === "," || c === ";") && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

export function planImport(f: CvFormat, lang: Lang, existing: Item[]): ImportPlan {
  const plan: ImportPlan = { inserts: [], updates: [], report: [] };
  const all = [...existing];
  const touched = new Map<string, Record<string, unknown>>();
  let created = 0, filled = 0;

  const dataOf = (it: Item) => touched.get(it.id) ?? it.data;
  const kids = (parent: string | null, section: string, kind?: string) =>
    all.filter((i) => i.parent_id === parent && i.section === section && (!kind || i.kind === kind)).sort((a, b) => a.sort - b.sort);

  /** Text fields are filled in `lang` only when empty there; neutral fields only when empty. */
  function merge(it: Item, fields: Record<string, unknown>) {
    const data = { ...dataOf(it) };
    let changed = false;
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === "" || v === null) continue;
      if (typeof v === "object" && !Array.isArray(v) && ("de" in (v as L) || "en" in (v as L))) {
        const cur = { ...((data[k] ?? {}) as L) };
        const val = (v as L)[lang];
        if (val && !cur[lang]?.trim()) { cur[lang] = val; data[k] = cur; changed = true; }
      } else if (data[k] === undefined || data[k] === "" || (Array.isArray(data[k]) && !(data[k] as unknown[]).length)) {
        data[k] = v; changed = true;
      }
    }
    if (!changed) return;
    touched.set(it.id, data);
    const ins = plan.inserts.find((i) => i.id === it.id);
    if (ins) ins.data = data;
    else { const u = plan.updates.find((x) => x.id === it.id); if (u) u.data = data; else { plan.updates.push({ id: it.id, data }); filled++; } }
  }
  function add(section: string, kind: string, parent: string | null, fields: Record<string, unknown>): Item {
    const siblings = kids(parent, section);
    const it: Item = { id: crypto.randomUUID(), section, kind, parent_id: parent, sort: (siblings[siblings.length - 1]?.sort ?? 0) + 10, data: {} };
    all.push(it);
    plan.inserts.push(it);
    created++;
    merge(it, fields);
    return it;
  }
  /** The n-th record of its kind under a parent, or a new one. */
  function nth(section: string, kind: string, parent: string | null, n: number, fields: Record<string, unknown>): Item {
    const it = kids(parent, section, kind)[n];
    if (it) { merge(it, fields); return it; }
    return add(section, kind, parent, fields);
  }
  const Lv = (s: string | undefined): L | undefined => (s && s.trim() ? { [lang]: s.trim() } : undefined);
  const range = (s: string) => { const r = parseRange(s); return { start: r.start, end: r.end, current: r.current || undefined, date_note: Lv(r.note) }; };

  // Header
  const fh = f.found;
  const header = all.find((i) => i.section === "header") ?? add("header", "header", null, {});
  merge(header, { name: fh.name || undefined, headline: Lv(fh.headline), location: Lv(fh.location), contacts: fh.contacts.length ? fh.contacts : undefined });

  for (const s of f.parsed.sections) {
    const key = sectionKeyOf(s.title);
    if (!key) { plan.report.push(`Left out: "${s.title}" (not a known section)`); continue; }
    if (s.kind === "paragraph") {
      if (key === "summary" || key === "highlights") nth(key, "snippet", null, 0, { label: `From the ${lang.toUpperCase()} CV`, text: Lv(texToMark(s.text.tex)) });
      continue;
    }
    if (s.kind === "rows") {
      const counters: Record<string, number> = {};
      for (const r of s.rows) {
        const label = texToMark(r.label.tex).replace(/:\s*$/, "");
        const text = texToMark(r.text.tex);
        const placed = joinableKeyOf(label);
        if (placed && placed !== key) {
          splitList(text).forEach((part, n) => {
            if (placed === "languages") {
              const m = part.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
              nth("languages", "language", null, n, { language: Lv(m ? m[1] : part), level: Lv(m?.[2]) });
            } else if (placed === "certifications") nth("certifications", "certification", null, n, { name: Lv(part) });
            else if (placed === "hobbies") nth("hobbies", "hobby", null, n, { title: Lv(part) });
            else if (placed === "research") nth("research", "interest", null, n, { title: Lv(part) });
            else if (placed === "achievements") nth("achievements", "achievement", null, n, { title: Lv(part) });
          });
          continue;
        }
        if (key === "skills") continue;   // skills live in the skills database
        const n = (counters[key] = (counters[key] ?? -1) + 1);
        if (key === "additional") nth(key, "info", null, n, { label: Lv(label), text: Lv(text) });
        else if (key === "personal") nth(key, "detail", null, n, { label: Lv(label), value: Lv(text) });
        else if (key === "languages") nth(key, "language", null, n, { language: Lv(label), level: Lv(text) });
        else if (key === "research") nth(key, "interest", null, n, { title: Lv(label), description: Lv(text) });
        else if (key === "hobbies") nth(key, "hobby", null, n, { title: Lv(label), description: Lv(text) });
        else plan.report.push(`Left out: a row "${label}" in "${s.title}"`);
      }
      continue;
    }
    if (s.kind !== "entries") { plan.report.push(`Left out: "${s.title}" (layout not recognised)`); continue; }

    const perCompany = new Map<string, number>();
    s.entries.forEach((e, n) => {
      const a = e.args.map((x) => texToMark(x.tex));
      const ctx = e.context ? Lv(texToMark(e.context.tex)) : undefined;
      const bullets = e.bullets.map((b) => texToMark(b.field.tex));
      let rec: Item;
      if (key === "experience") {
        let company = kids(null, "experience", "company").find((c) => {
          const d = dataOf(c).name as L | undefined;
          return [d?.de, d?.en].some((x) => x && norm(x) === norm(a[0]));
        });
        if (!company) company = add("experience", "company", null, { name: Lv(a[0]), location: Lv(a[3]) });
        else merge(company, { name: Lv(a[0]), location: Lv(a[3]) });
        const k = perCompany.get(company.id) ?? 0;
        perCompany.set(company.id, k + 1);
        rec = nth("experience", "role", company.id, k, { title: Lv(a[2]), ...range(a[1]), context: ctx });
      } else if (key === "education") {
        const g = a[2].match(/\s*\(((?:Note|Grade|CGPA|GPA|Abschlussnote)[^)]*)\)\s*$/i);
        rec = nth(key, "education", null, n, { institution: Lv(a[0]), degree: Lv(g ? a[2].slice(0, g.index).trim() : a[2]), grade: Lv(g?.[1]), ...range(a[1]), location: Lv(a[3]), context: ctx });
      } else if (key === "projects") {
        const l = a[2].match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
        rec = nth(key, "project", null, n, { title: Lv(a[0]), ...range(a[1]), url: l?.[2], url_text: l?.[1], tech: Lv(l ? a[3] : [a[2], a[3]].filter(Boolean).join(" · ")), context: ctx });
      } else if (key === "certifications") {
        rec = nth(key, "certification", null, n, { name: Lv(a[0]), date: parseRange(a[1]).start, issuer: Lv(a[2]) });
      } else if (key === "volunteering") {
        rec = nth(key, "volunteering", null, n, { org: Lv(a[0]), ...range(a[1]), role: Lv(a[2]), location: Lv(a[3]) });
      } else if (key === "publications") {
        rec = nth(key, "publication", null, n, { title: Lv(a[0]), year: a[1] || undefined, venue: Lv(a[2]) });
      } else {
        plan.report.push(`Left out: an entry in "${s.title}"`);
        return;
      }
      bullets.forEach((t, j) => nth(key, "bullet", rec.id, j, { text: Lv(t) }));
    });
  }
  plan.report.unshift(`${created} new record${created === 1 ? "" : "s"}, ${filled} filled in ${lang.toUpperCase()}`);
  return plan;
}
