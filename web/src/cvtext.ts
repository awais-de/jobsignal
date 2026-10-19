// The CV as one text (owner decision 2026-10-19): ticks on the left insert their text at its place in one
// big text box; the owner edits freely; on compile the text is split back into sections, entries, bullets
// and rows and written in the format (renderTex). Pure functions, no network.
//
// The text, Markdown-like:
//   # Berufserfahrung                       a section (title as on the CV)
//   ## Beispiel GmbH | 11/2023 – 06/2024    an entry's first heading line (left | right)
//   Data Engineer | Berlin, Deutschland     its second heading line (left | right), optional
//   > E-Commerce (…)                        its context line, optional
//   - Designed and led …                    a bullet (a following line without a marker continues it)
//   Programmierung: SQL, Python             a row (label: text), in rows sections
//   Any other text                          a paragraph, in text sections

import {
  bulletText, entrySources, newEntry, placementsOf,
  type CvFormat, type DEntry, type DHeader, type DRow, type DSection, type Master, type SkillGroup,
} from "./cvformat";
import { coursesPrefix, joinText, rowOf, SECTIONS, sectionSpec, tr, type Item, type Lang, type Style } from "./cvschema";

export type TextDraft = { v: 2; header: DHeader; text: string; ticked: string[]; company?: string };   // company: ad-hoc CVs (file name)

// -- what can be ticked ----------------------------------------------------------------------------
export type Tick =
  | { kind: "section"; key: string; section: string }
  | { kind: "entry"; key: string; section: string; item: Item; lines: string[] }
  | { kind: "bullet"; key: string; section: string; entry: string; text: string; course?: string }
  | { kind: "para"; key: string; section: string; text: string }
  | { kind: "line"; key: string; section: string; line: string }               // a bullet or a row of the section itself
  | { kind: "join"; key: string; section: string; row: string; part: string };    // a part of a row ("Sprachen: …")

export type PlanGroup = { title: string; note?: string; ticks: (Tick & { label: string; children?: (Tick & { label: string })[] })[] };
export type PlanSection = { key: string; title: string; style: Style; groups: PlanGroup[] };

/** The entry's heading lines as they appear in the text. */
export function entryLines(e: DEntry): string[] {
  const pair = (a: string, b: string) => [a, b].map((x) => x.trim()).filter(Boolean).join(" | ");
  const out = [`## ${pair(e.slots[0], e.slots[1]) || "Entry"}`];
  const second = pair(e.slots[2], e.slots[3]);
  if (second) out.push(second);
  if (e.context.trim()) out.push(`> ${e.context.trim()}`);
  return out;
}

/** The left pane: every section in order, and what each offers to tick. */
export function buildPlan(f: CvFormat, m: Master, skills: SkillGroup[]): PlanSection[] {
  const lang = f.lang;
  const placed = placementsOf(f);
  const order = f.sections.map((s) => s.key);
  if (!order.includes("highlights")) order.splice(order.includes("summary") ? order.indexOf("summary") + 1 : 0, 0, "highlights");
  for (const s of SECTIONS) if (!order.includes(s.key) && !placed[s.key]) order.push(s.key);
  const titleOf = (key: string) => f.sections.find((s) => s.key === key)?.title ?? sectionSpec(key)!.title[lang];

  return order.map((key) => {
    const spec = sectionSpec(key)!;
    const title = titleOf(key);
    const style = f.sections.find((s) => s.key === key)?.style ?? spec.style;
    const groups: PlanGroup[] = [];
    const own = m.roots(key);
    if (key === "skills") {
      for (const g of skills) {
        groups.push({ title: g.label, ticks: g.items.map((s) => ({ kind: "join" as const, key: `k:${s.id}`, section: key, row: g.label, part: s.name, label: s.name })) });
      }
    } else if (style === "entries") {
      groups.push({
        title: "", ticks: own.map((it) => {
          const e = newEntry(it, m, f, true);
          const lines = entryLines(e);
          const children = entrySources(e, m).map((c) => (c.kind === "course"
            ? { kind: "bullet" as const, key: `c:${it.id}:${c.id}`, section: key, entry: `e:${it.id}`, text: bulletText(c, lang), course: coursesPrefix(lang), label: `Course: ${bulletText(c, lang)}` }
            : { kind: "bullet" as const, key: `b:${it.id}:${c.id}`, section: key, entry: `e:${it.id}`, text: bulletText(c, lang), label: `${c.kind === "achievement" ? "🏆 " : ""}${bulletText(c, lang)}` }));
          return { kind: "entry" as const, key: `e:${it.id}`, section: key, item: it, lines, label: [e.slots[2], e.slots[0], e.slots[1]].filter((x) => x.trim()).join(" · ") || lines[0].slice(3), children };
        }),
      });
    } else if (style === "text") {
      groups.push({ title: "", ticks: own.map((it) => ({ kind: "para" as const, key: `p:${it.id}`, section: key, text: tr(it.data.text, lang), label: (it.data.label as string) || tr(it.data.text, lang).slice(0, 60) })) });
    } else if (style === "bullets") {
      groups.push({ title: "", ticks: own.map((it) => { const t = bulletText(it, lang); return { kind: "line" as const, key: `l:${it.id}`, section: key, line: `- ${t}`, label: t }; }) });
    } else {
      groups.push({ title: "", ticks: own.map((it) => { const r = rowOf(it, lang); const line = r.label ? `${r.label}: ${r.text}` : `- ${r.text}`; return { kind: "line" as const, key: `l:${it.id}`, section: key, line, label: line.replace(/^- /, "") }; }) });
    }
    // Sections the format writes as a row here ("Sprachen" in "Kenntnisse").
    for (const [joined, target] of Object.entries(placed)) {
      if (target !== key) continue;
      const label = sectionSpec(joined)!.title[lang];
      groups.push({ title: label, note: `a row in ${title}`, ticks: m.roots(joined).map((it) => ({ kind: "join" as const, key: `j:${it.id}`, section: key, row: label, part: joinText(it, lang), label: joinText(it, lang) })) });
    }
    return { key, title, style, groups };
  });
}

/** Every tick by key (entries' bullets included). */
export function tickIndex(plan: PlanSection[]): Map<string, Tick & { label: string }> {
  const out = new Map<string, Tick & { label: string }>();
  for (const s of plan) {
    out.set(`sec:${s.key}`, { kind: "section", key: `sec:${s.key}`, section: s.key, label: s.title });
    for (const g of s.groups) for (const t of g.ticks) { out.set(t.key, t); for (const c of t.children ?? []) out.set(c.key, c); }
  }
  return out;
}

// -- editing the text ------------------------------------------------------------------------------
const isSection = (l: string) => /^#\s+\S/.test(l);
const isEntry = (l: string) => /^##\s+\S/.test(l);
const norm = (s: string) => s.trim().toLowerCase();

function sectionSpan(ls: string[], title: string): [number, number] | null {
  const s = ls.findIndex((l) => isSection(l) && norm(l.slice(1)) === norm(title));
  if (s < 0) return null;
  let e = s + 1;
  while (e < ls.length && !isSection(ls[e])) e++;
  return [s, e];
}
function ensureSection(ls: string[], title: string, order: string[]): [number, number] {
  const found = sectionSpan(ls, title);
  if (found) return found;
  // Before the first later section (in the CV's order) that is in the text, else at the end.
  const later = order.slice(order.findIndex((t) => norm(t) === norm(title)) + 1);
  let at = ls.length;
  for (const t of later) { const sp = sectionSpan(ls, t); if (sp) { at = sp[0]; break; } }
  const block = [`# ${title}`, ""];
  if (at > 0 && ls[at - 1].trim()) block.unshift("");
  ls.splice(at, 0, ...block);
  return sectionSpan(ls, title)!;
}
/** The end of a span without its trailing blank lines. */
function contentEnd(ls: string[], start: number, end: number) {
  let at = end;
  while (at - 1 > start && !ls[at - 1].trim()) at--;
  return at;
}
function entrySpan(ls: string[], sec: [number, number], heading: string): [number, number] | null {
  let s = -1;
  for (let i = sec[0] + 1; i < sec[1]; i++) if (isEntry(ls[i]) && norm(ls[i]) === norm(heading)) { s = i; break; }
  if (s < 0) return null;
  let e = s + 1;
  while (e < sec[1] && !isEntry(ls[e])) e++;
  return [s, e];
}
function tidy(ls: string[]): string {
  const out: string[] = [];
  for (const l of ls) {
    if (!l.trim() && out.length && !out[out.length - 1].trim()) continue;          // one blank line at most
    if (isSection(l) && out.length && out[out.length - 1].trim()) out.push("");     // a blank line before a section
    out.push(l.replace(/\s+$/, ""));
  }
  while (out.length && !out[0].trim()) out.shift();
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

export type TickResult = { text: string; ticked: string[]; note?: string };

/** Ticking inserts the item's text at its place; unticking removes it only while it's unchanged. */
export function applyTick(d: TextDraft, t: Tick, on: boolean, plan: PlanSection[]): TickResult {
  const ls = d.text.trim() ? d.text.replace(/\n$/, "").split("\n") : [];
  const order = plan.map((s) => s.title);
  const title = plan.find((s) => s.key === t.section)!.title;
  let ticked = on ? [...new Set([...d.ticked, t.key])] : d.ticked.filter((k) => k !== t.key);
  let note: string | undefined;
  const removeLine = (line: string, span: [number, number] | null) => {
    if (!span) return false;
    for (let i = span[0]; i < span[1]; i++) if (ls[i].trim() === line.trim()) { ls.splice(i, 1); return true; }
    return false;
  };

  if (t.kind === "section") {
    if (on) ensureSection(ls, title, order);
    else {
      const sp = sectionSpan(ls, title);
      if (sp && ls.slice(sp[0] + 1, sp[1]).some((l) => l.trim())) { note = `“${title}” still has text: delete it in the box.`; ticked = [...ticked, t.key]; }
      else if (sp) ls.splice(sp[0], sp[1] - sp[0]);
    }
  } else if (t.kind === "entry" || t.kind === "bullet") {
    const entry = (t.kind === "entry" ? t : plan.flatMap((s) => s.groups.flatMap((g) => g.ticks)).find((x) => x.key === t.entry)) as Extract<Tick, { kind: "entry" }> & { children?: Tick[] };
    const sec = ensureSection(ls, title, order);
    let span = entrySpan(ls, sec, entry.lines[0]);
    if (on && !span) {
      ls.splice(contentEnd(ls, sec[0], sec[1]), 0, ...(sec[1] - sec[0] > 1 && ls[contentEnd(ls, sec[0], sec[1]) - 1].trim() ? [""] : []), ...entry.lines);
      span = entrySpan(ls, sectionSpan(ls, title)!, entry.lines[0]);
      ticked = [...new Set([...ticked, entry.key])];
    }
    if (t.kind === "entry" && !on && span) {
      // Only an untouched entry goes: its heading lines and bullets still exactly as ticked in.
      const known = new Set([...entry.lines, ...(entry.children ?? []).map((c) => c.kind === "bullet" ? `- ${c.text}` : "")].map(norm));
      const body = ls.slice(span[0], span[1]).filter((l) => l.trim());
      const course = (entry.children ?? []).find((c) => c.kind === "bullet" && c.course) as Extract<Tick, { kind: "bullet" }> | undefined;
      if (body.every((l) => known.has(norm(l)) || (course && norm(l).startsWith(norm(`- ${course.course}`))))) {
        ls.splice(span[0], span[1] - span[0]);
        ticked = ticked.filter((k) => !(entry.children ?? []).some((c) => c.key === k));
      } else { note = "This entry was edited in the box: delete it there."; ticked = [...ticked, t.key]; }
    }
    if (t.kind === "bullet" && span) {
      if (t.course) {
        const pre = `- ${t.course}`;
        const i = ls.slice(span[0], span[1]).findIndex((l) => l.startsWith(pre));
        if (on) {
          if (i >= 0) ls[span[0] + i] = `${ls[span[0] + i].trimEnd()}, ${t.text}`;
          else ls.splice(contentEnd(ls, span[0], span[1]), 0, `${pre}${t.text}`);
        } else if (i >= 0) {
          const parts = ls[span[0] + i].slice(pre.length).split(",").map((p) => p.trim()).filter((p) => p && p !== t.text);
          if (parts.length) ls[span[0] + i] = pre + parts.join(", "); else ls.splice(span[0] + i, 1);
        }
      } else if (on) ls.splice(contentEnd(ls, span[0], span[1]), 0, `- ${t.text}`);
      else if (!removeLine(`- ${t.text}`, span)) note = "That bullet was edited in the box: delete it there.";
    }
  } else if (t.kind === "para") {
    const sec = ensureSection(ls, title, order);
    if (on) {
      const at = contentEnd(ls, sec[0], sec[1]);
      ls.splice(at, 0, ...(at - 1 > sec[0] ? [""] : []), t.text);
    } else if (!removeLine(t.text, sec)) note = "That text was edited in the box: delete it there.";
  } else if (t.kind === "line") {
    const sec = ensureSection(ls, title, order);
    if (on) ls.splice(contentEnd(ls, sec[0], sec[1]), 0, t.line);
    else if (!removeLine(t.line, sec)) note = "That line was edited in the box: delete it there.";
  } else if (t.kind === "join") {
    const sec = ensureSection(ls, title, order);
    const pre = `${t.row}:`;
    const i = ls.slice(sec[0], sec[1]).findIndex((l) => norm(l).startsWith(norm(pre)));
    if (on) {
      if (i >= 0) { const l = ls[sec[0] + i].trimEnd(); ls[sec[0] + i] = l.endsWith(":") ? `${l} ${t.part}` : `${l}, ${t.part}`; }
      else ls.splice(contentEnd(ls, sec[0], sec[1]), 0, `${pre} ${t.part}`);
    } else if (i >= 0) {
      const l = ls[sec[0] + i];
      const parts = l.slice(l.indexOf(":") + 1).split(/,(?![^(]*\))/).map((p) => p.trim()).filter((p) => p && p !== t.part.trim());
      if (parts.length) ls[sec[0] + i] = `${pre} ${parts.join(", ")}`; else ls.splice(sec[0] + i, 1);
    }
  }
  return { text: tidy(ls), ticked, note };
}

// -- reading the text back -------------------------------------------------------------------------
const ROW = /^([^:]{1,60}?):\s+(.*)$/;
const isRowLine = (l: string) => ROW.test(l) && !/^https?$/i.test(l.split(":")[0]);

export type Parsed = { sections: DSection[]; problems: string[]; outline: string[] };

export function parseCvText(text: string, f: CvFormat, lang: Lang): Parsed {
  const problems: string[] = [];
  const raw: { title: string; lines: { t: string; n: number }[] }[] = [];
  text.split("\n").forEach((l, i) => {
    const t = l.replace(/\s+$/, "");
    if (isSection(t)) { raw.push({ title: t.replace(/^#\s+/, "").trim(), lines: [] }); return; }
    if (!raw.length) { if (t.trim()) problems.push(`Line ${i + 1} is above the first “# ” heading: left out.`); return; }
    raw[raw.length - 1].lines.push({ t, n: i + 1 });
  });

  const sections: DSection[] = raw.map((r, idx) => {
    const fs = f.sections.find((s) => norm(s.title) === norm(r.title));
    const key = fs?.key ?? SECTIONS.find((s) => s.match.test(r.title) || norm(s.title[lang]) === norm(r.title))?.key ?? `custom${idx}`;
    const content = r.lines.filter((l) => l.t.trim());
    const known = fs?.style ?? sectionSpec(key)?.style;
    let style: Style;
    if (content.some((l) => isEntry(l.t))) style = "entries";
    else if (known && known !== "entries") style = known;
    else if (content.length && content.every((l) => l.t.startsWith("- "))) style = "bullets";
    else if (content.length && content.every((l) => isRowLine(l.t) || l.t.startsWith("- "))) style = "rows";
    else style = "text";
    const d: DSection = { key, on: true, title: r.title, style, into: null, text: "", bullets: [], entries: [], rows: [], picked: [] };

    if (style === "text") d.text = content.map((l) => l.t.replace(/^- /, "").trim()).join(" ");
    if (style === "bullets") {
      for (const l of content) {
        if (l.t.startsWith("- ")) d.bullets.push({ text: l.t.slice(2).trim() });
        else if (d.bullets.length) d.bullets[d.bullets.length - 1].text += ` ${l.t.trim()}`;
        else d.bullets.push({ text: l.t.trim() });
      }
    }
    if (style === "rows") {
      for (const l of content) {
        const t = l.t.trim();
        const m = !t.startsWith("- ") && t.match(ROW);
        if (m) d.rows.push({ src: `custom:${l.n}`, label: m[1].trim(), text: m[2].trim() } as DRow);
        else if (t.startsWith("- ") || !d.rows.length) d.rows.push({ src: `custom:${l.n}`, label: "", text: t.replace(/^- /, "") });
        else d.rows[d.rows.length - 1].text += ` ${t}`;
      }
    }
    if (style === "entries") {
      let e: DEntry | null = null, second = false;
      for (const l of content) {
        const t = l.t.trim();
        if (isEntry(t)) {
          const [a, ...b] = t.replace(/^##\s+/, "").split(/\s+\|\s+/);
          e = { src: null, on: true, slots: [a, b.join(" | "), "", ""], context: "", bullets: [], picked: [] };
          d.entries.push(e); second = false;
        } else if (!e) problems.push(`Line ${l.n} in “${r.title}” is above its first “## ” entry: left out.`);
        else if (t.startsWith("> ")) e.context = t.slice(2).trim();
        else if (t.startsWith("- ")) e.bullets.push({ text: t.slice(2).trim() });
        else if (!second && !e.bullets.length && !e.context) { const [c, ...dd] = t.split(/\s+\|\s+/); e.slots[2] = c; e.slots[3] = dd.join(" | "); second = true; }
        else if (e.bullets.length) e.bullets[e.bullets.length - 1].text += ` ${t}`;
        else if (e.context) e.context += ` ${t}`;
        else problems.push(`Line ${l.n} in “${r.title}” couldn't be placed: start it with “- ” for a bullet.`);
      }
    }
    return d;
  });

  const outline = sections.map((s) => {
    const what = s.style === "entries" ? `${s.entries.length} entr${s.entries.length === 1 ? "y" : "ies"}, ${s.entries.reduce((n, e) => n + e.bullets.length, 0)} bullets`
      : s.style === "bullets" ? `${s.bullets.length} bullet${s.bullets.length === 1 ? "" : "s"}` : s.style === "rows" ? `${s.rows.length} row${s.rows.length === 1 ? "" : "s"}` : s.text ? "paragraph" : "empty";
    return `${s.title}: ${what}${s.key.startsWith("custom") ? " (new section)" : ""}`;
  });
  return { sections, problems, outline };
}
