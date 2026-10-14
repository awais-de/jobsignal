import { useCallback, useEffect, useMemo, useState } from "react";
import { detectFormat, type Contact } from "./cvformat";
import { planImport } from "./cvimport";
import { ITEM_COLUMNS, itemLabel, kindSpec, SECTIONS, type FieldSpec, type Item, type L, type Lang } from "./cvschema";
import { supabase } from "./supabase";

// Master CV (Me → Master CV; owner decision 2026-10-14): the content every tailored CV is made from, as
// separate records per section, each text in German and English. The uploaded LaTeX files are only the
// formats. The generator on a job's page offers these records; nothing there is written back here.

export type BaseCv = { id: string; lang: Lang; version: number; label: string | null; tex_source: string; created_at: string };
export const BASE_COLUMNS = "id,lang,version,label,tex_source,created_at";

export async function loadItems(): Promise<Item[]> {
  const out: Item[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("cv_items").select(ITEM_COLUMNS).is("deleted_at", null).order("sort").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data as Item[]));
    if (data.length < 1000) return out;
  }
}

export default function MasterCv() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => loadItems().then(setItems, (e) => setError(e.message)), []);
  useEffect(() => { reload(); }, [reload]);

  const ops = useMemo(() => ({
    async save(id: string, data: Record<string, unknown>) {
      setItems((is) => is && is.map((i) => (i.id === id ? { ...i, data } : i)));
      const { error } = await supabase.from("cv_items").update({ data }).eq("id", id);
      if (error) setError(error.message);
    },
    async add(section: string, kind: string, parent: string | null, siblings: Item[]) {
      const sort = (siblings[siblings.length - 1]?.sort ?? 0) + 10;
      const { data, error } = await supabase.from("cv_items").insert({ section, kind, parent_id: parent, sort, data: {} }).select(ITEM_COLUMNS).single();
      if (error) return setError(error.message);
      setItems((is) => is && [...is, data as Item]);
    },
    async remove(it: Item) {
      if (!window.confirm(`Delete "${itemLabel(it)}"${kindSpec(it.section, it.kind)?.children ? " and everything under it" : ""}?`)) return;
      const { error } = await supabase.from("cv_items").delete().eq("id", it.id);
      if (error) return setError(error.message);
      reload();
    },
    async move(it: Item, siblings: Item[], dir: -1 | 1) {
      const i = siblings.findIndex((s) => s.id === it.id), j = i + dir;
      if (j < 0 || j >= siblings.length) return;
      const other = siblings[j];
      // Distinct sort values, then swap.
      const a = it.sort === other.sort ? other.sort + dir : other.sort, b = it.sort;
      setItems((is) => is && is.map((x) => (x.id === it.id ? { ...x, sort: a } : x.id === other.id ? { ...x, sort: b } : x)));
      await supabase.from("cv_items").update({ sort: a }).eq("id", it.id);
      await supabase.from("cv_items").update({ sort: b }).eq("id", other.id);
    },
  }), [reload]);

  if (!items) return <p className="empty">{error ?? "Loading…"}</p>;
  const kids = (parent: string | null, section: string) =>
    items.filter((i) => i.parent_id === parent && i.section === section).sort((a, b) => a.sort - b.sort);
  // Records an achievement or project can belong to.
  const refs = items.filter((i) => i.kind === "role" || i.kind === "education")
    .map((i) => ({ id: i.id, label: itemLabel(i, i.parent_id ? items.find((p) => p.id === i.parent_id) : undefined) }));

  return (
    <div className="master-cv">
      <p className="muted">
        Everything your CVs can contain, once, in German and English. The generator on each job's CV tab offers these records to tick;
        what you change there stays with that CV. Write a link as <code>[text](https://…)</code> and bold as <code>**text**</code>.
      </p>
      {error && <p className="notice">{error} <button className="link" onClick={() => setError(null)}>×</button></p>}
      <Formats items={items} onImported={reload} onError={setError} />
      <HeaderCard item={items.find((i) => i.section === "header")} onSave={ops.save}
                  onCreate={async () => { await ops.add("header", "header", null, []); }} />
      {SECTIONS.map((spec) => {
        if (spec.key === "skills") {
          return (
            <details key={spec.key} className="card mcv-section">
              <summary><strong>{spec.title.en}</strong> <span className="muted small">/ {spec.title.de} · from the skills database</span></summary>
              <p className="muted">Skills come from the <a href="#skills">skills database</a>: your ratings decide what's offered, and the category labels (DE/EN) become the rows.</p>
            </details>
          );
        }
        const root = spec.kinds[0];
        const list = kids(null, spec.key);
        const count = list.length;
        return (
          <details key={spec.key} className="card mcv-section" open={false}>
            <summary>
              <strong>{spec.title.en}</strong> <span className="muted small">/ {spec.title.de} · {count} {plural(root.label.toLowerCase(), count)}</span>
            </summary>
            {spec.help && <p className="muted small">{spec.help}</p>}
            {list.map((it) => (
              <Record key={it.id} it={it} siblings={list} items={items} refs={refs} ops={ops} depth={0} />
            ))}
            <button className="small" onClick={() => ops.add(spec.key, root.kind, null, list)}>+ Add {root.label.toLowerCase()}</button>
          </details>
        );
      })}
    </div>
  );
}

const plural = (w: string, n: number) => (n === 1 ? w : /y$/.test(w) && !/[aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);

type Ops = {
  save: (id: string, data: Record<string, unknown>) => Promise<void>;
  add: (section: string, kind: string, parent: string | null, siblings: Item[]) => Promise<void>;
  remove: (it: Item) => Promise<void>;
  move: (it: Item, siblings: Item[], dir: -1 | 1) => Promise<void>;
};

function Record({ it, siblings, items, refs, ops, depth }: {
  it: Item; siblings: Item[]; items: Item[]; refs: { id: string; label: string }[]; ops: Ops; depth: number;
}) {
  const spec = kindSpec(it.section, it.kind);
  if (!spec) return null;
  const children = items.filter((c) => c.parent_id === it.id).sort((a, b) => a.sort - b.sort);
  const set = (key: string, v: unknown) => ops.save(it.id, { ...it.data, [key]: v });
  const small = spec.fields.length === 1;   // bullets, courses: one text, compact
  return (
    <div className={`mcv-record depth-${depth}${small ? " compact" : ""}`}>
      <div className="mcv-record-head">
        <span className="mcv-kind">{spec.label}</span>
        {!small && <strong className="mcv-title">{itemLabel(it, it.parent_id ? items.find((p) => p.id === it.parent_id) : undefined)}</strong>}
        <span className="mcv-tools">
          <button className="link" aria-label="Move up" onClick={() => ops.move(it, siblings, -1)}>↑</button>
          <button className="link" aria-label="Move down" onClick={() => ops.move(it, siblings, 1)}>↓</button>
          <button className="link danger" aria-label="Delete" onClick={() => ops.remove(it)}>×</button>
        </span>
      </div>
      <div className={small ? "" : "mcv-fields"}>
        {spec.fields.map((f) => <FieldInput key={f.key} f={f} value={it.data[f.key]} refs={refs} onSave={(v) => set(f.key, v)} bare={small} />)}
      </div>
      {spec.children?.map((ck) => {
        const cs = kindSpec(it.section, ck)!;
        const list = children.filter((c) => c.kind === ck);
        return (
          <div key={ck} className="mcv-children">
            {list.map((c) => <Record key={c.id} it={c} siblings={list} items={items} refs={refs} ops={ops} depth={depth + 1} />)}
            <button className="link small" onClick={() => ops.add(it.section, ck, it.id, list)}>+ {cs.label.toLowerCase()}</button>
          </div>
        );
      })}
    </div>
  );
}

/** One field: DE | EN side by side for texts; neutral fields once. Saved when leaving the box. */
function FieldInput({ f, value, refs, onSave, bare }: {
  f: FieldSpec; value: unknown; refs: { id: string; label: string }[]; onSave: (v: unknown) => void; bare?: boolean;
}) {
  if (f.type === "text" || f.type === "long") {
    const v = (value ?? {}) as L;
    return (
      <div className={`mcv-field bi${f.type === "long" ? " long" : ""}`}>
        {!bare && <span className="mcv-label">{f.label}</span>}
        {(["de", "en"] as Lang[]).map((lang) => (
          <BiBox key={lang} lang={lang} long={f.type === "long"} value={v[lang] ?? ""} hint={f.hint}
                 onSave={(t) => onSave({ ...v, [lang]: t })} />
        ))}
      </div>
    );
  }
  if (f.type === "bool") {
    return (
      <label className="mcv-field check">
        <input type="checkbox" checked={!!value} onChange={(e) => onSave(e.target.checked)} /> {f.label}
      </label>
    );
  }
  if (f.type === "ref") {
    return (
      <label className="mcv-field">
        <span className="mcv-label">{f.label}</span>
        <select value={(value as string) ?? ""} onChange={(e) => onSave(e.target.value || null)}>
          <option value="">— nothing (stands alone)</option>
          {refs.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </label>
    );
  }
  return (
    <label className="mcv-field">
      <span className="mcv-label">{f.label}</span>
      <PlainBox value={(value as string) ?? ""} hint={f.hint} type={f.type === "url" ? "url" : "text"} onSave={(t) => onSave(t)} />
    </label>
  );
}

function BiBox({ lang, long, value, hint, onSave }: { lang: Lang; long: boolean; value: string; hint?: string; onSave: (t: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const blur = () => { if (v.trim() !== value) onSave(v.trim()); };
  return (
    <span className="bi-box">
      <span className="lang-tag">{lang.toUpperCase()}</span>
      {long
        ? <textarea rows={2} value={v} placeholder={hint} onChange={(e) => setV(e.target.value)} onBlur={blur} />
        : <input value={v} placeholder={hint} onChange={(e) => setV(e.target.value)} onBlur={blur} />}
    </span>
  );
}

function PlainBox({ value, hint, type, onSave }: { value: string; hint?: string; type: string; onSave: (t: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input type={type} value={v} placeholder={hint} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() !== value && onSave(v.trim())} />;
}

/** Name, headline, location and contact items: the header of every CV (each can be changed per CV). */
function HeaderCard({ item, onSave, onCreate }: { item: Item | undefined; onSave: Ops["save"]; onCreate: () => Promise<void> }) {
  if (!item) {
    return (
      <section className="card">
        <h3>Header</h3>
        <p className="muted">Import a CV above, or start empty.</p>
        <button className="small" onClick={onCreate}>Start the header</button>
      </section>
    );
  }
  const d = item.data;
  const contacts = (Array.isArray(d.contacts) ? d.contacts : []) as Contact[];
  const set = (k: string, v: unknown) => onSave(item.id, { ...d, [k]: v });
  const setContacts = (c: Contact[]) => set("contacts", c);
  return (
    <section className="card">
      <h3>Header</h3>
      <p className="muted small">The location is usually changed per CV, in the generator.</p>
      <div className="mcv-fields">
        <label className="mcv-field"><span className="mcv-label">Name</span>
          <PlainBox value={typeof d.name === "string" ? d.name : ""} type="text" onSave={(t) => set("name", t)} /></label>
        <FieldInput f={{ key: "headline", label: "Headline", type: "text" }} value={d.headline} refs={[]} onSave={(v) => set("headline", v)} />
        <FieldInput f={{ key: "location", label: "Location", type: "text" }} value={d.location} refs={[]} onSave={(v) => set("location", v)} />
      </div>
      <div className="mcv-label">Contact items (in this order, between the separators)</div>
      {contacts.map((c, i) => (
        <div key={i} className="row mcv-contact">
          <PlainBox value={c.text} hint="Text shown" type="text" onSave={(t) => setContacts(contacts.map((x, j) => (j === i ? { ...x, text: t } : x)))} />
          <PlainBox value={c.url} hint="Link (optional): mailto:…, https://…" type="text" onSave={(t) => setContacts(contacts.map((x, j) => (j === i ? { ...x, url: t } : x)))} />
          <button className="link" aria-label="Move up" onClick={() => i > 0 && setContacts(contacts.map((x, j) => (j === i - 1 ? contacts[i] : j === i ? contacts[i - 1] : x)))}>↑</button>
          <button className="link danger" aria-label="Remove" onClick={() => setContacts(contacts.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="link small" onClick={() => setContacts([...contacts, { text: "", url: "" }])}>+ contact item</button>
    </section>
  );
}

// -- formats ---------------------------------------------------------------------------------------
function formatSummary(tex: string, lang: Lang): { ok: boolean; text: string } {
  try {
    const f = detectFormat(tex, lang);
    const titles = f.sections.map((s) => s.title + (s.rows.filter((r) => r !== "own").length ? ` (+ ${s.rows.filter((r) => r !== "own").join(", ")})` : "")).join(", ");
    return { ok: true, text: `Header ✓${f.header.contacts ? "" : " (no contact line found)"} · ${titles} · dates like ${f.date.month}${f.skipped.length ? ` · left out: ${f.skipped.join(", ")}` : ""}` };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : "Can't be read." };
  }
}

function Formats({ items, onImported, onError }: { items: Item[]; onImported: () => void; onError: (m: string) => void }) {
  const [list, setList] = useState<BaseCv[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from("base_cvs").select(BASE_COLUMNS).is("deleted_at", null).order("lang").order("version", { ascending: false });
    if (error) return onError(error.message);
    setList(data as BaseCv[]);
  }, [onError]);
  useEffect(() => { load(); }, [load]);

  async function remove(b: BaseCv) {
    if (!window.confirm(`Remove the ${b.lang.toUpperCase()} format v${b.version}? CVs already made with it keep their record.`)) return;
    const { error } = await supabase.from("base_cvs").update({ deleted_at: new Date().toISOString() }).eq("id", b.id);
    if (error) return onError(error.message);
    load();
  }
  function download(b: BaseCv) {
    const url = URL.createObjectURL(new Blob([b.tex_source], { type: "application/x-tex" }));
    Object.assign(document.createElement("a"), { href: url, download: `cv_format_${b.lang}_v${b.version}.tex` }).click();
    URL.revokeObjectURL(url);
  }
  async function importFrom(b: BaseCv) {
    if (!window.confirm(`Import the content of ${b.lang.toUpperCase()} v${b.version} into the master CV? Only empty ${b.lang.toUpperCase()} fields are filled; nothing is overwritten.`)) return;
    await runImport(b.tex_source, b.lang, items, onError, onImported);
  }

  return (
    <section className="card">
      <h3>CV formats</h3>
      <p className="muted">
        Your LaTeX CV as the layout, per language: the header layout, the sections' order, titles and styles, and the date style are read
        from it; its text isn't used (except once, if you import it). Every upload is a new version.
      </p>
      {list && list.length === 0 && <p className="muted">None yet.</p>}
      {list && list.length > 0 && (
        <ul className="base-list">
          {list.map((b) => {
            const s = formatSummary(b.tex_source, b.lang);
            return (
              <li key={b.id}>
                <strong>{b.lang.toUpperCase()} v{b.version}</strong>{b.label && <span> · {b.label}</span>}
                <span className={s.ok ? "muted" : "notice-inline"}> · {s.text}</span>
                <button className="link" onClick={() => download(b)}>.tex</button>
                <button className="link" onClick={() => importFrom(b)}>Import content</button>
                <button className="link danger" onClick={() => remove(b)}>Remove</button>
              </li>
            );
          })}
        </ul>
      )}
      <button className="small" onClick={() => setAdding((a) => !a)}>{adding ? "Cancel" : "+ Upload a format"}</button>
      {adding && <UploadFormat existing={list ?? []} items={items} onError={onError}
                               onSaved={() => { setAdding(false); load(); onImported(); }} />}
    </section>
  );
}

async function runImport(tex: string, lang: Lang, items: Item[], onError: (m: string) => void, onDone: () => void) {
  try {
    const plan = planImport(detectFormat(tex, lang), lang, items);
    if (plan.inserts.length) {
      // Parents before children (ids are made here, so one batch per depth).
      const depth = (it: Item): number => (it.parent_id ? 1 + depth(plan.inserts.find((p) => p.id === it.parent_id) ?? { ...it, parent_id: null }) : 0);
      for (const level of [0, 1, 2]) {
        const rows = plan.inserts.filter((i) => depth(i) === level);
        if (!rows.length) continue;
        const { error } = await supabase.from("cv_items").insert(rows);
        if (error) throw new Error(error.message);
      }
    }
    for (const u of plan.updates) {
      const { error } = await supabase.from("cv_items").update({ data: u.data }).eq("id", u.id);
      if (error) throw new Error(error.message);
    }
    window.alert(`Imported: ${plan.report.join("\n")}`);
    onDone();
  } catch (e) {
    onError(`Import failed: ${e instanceof Error ? e.message : e}`);
  }
}

function UploadFormat({ existing, items, onSaved, onError }: {
  existing: BaseCv[]; items: Item[]; onSaved: () => void; onError: (m: string) => void;
}) {
  const [tex, setTex] = useState("");
  const [lang, setLang] = useState<Lang>("de");
  const [label, setLabel] = useState("");
  const [doImport, setDoImport] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (/\\usepackage\[[^\]]*ngerman[^\]]*\]\{babel\}/.test(tex)) setLang("de");
    else if (/\\usepackage\[[^\]]*english[^\]]*\]\{babel\}/.test(tex)) setLang("en");
  }, [tex]);
  const summary = tex.trim() ? formatSummary(tex, lang) : null;
  const next = Math.max(0, ...existing.filter((b) => b.lang === lang).map((b) => b.version)) + 1;

  async function save() {
    setBusy(true);
    const { error } = await supabase.from("base_cvs").insert({ lang, version: next, label: label.trim() || null, tex_source: tex });
    if (error) { setBusy(false); return onError(error.code === "23505" ? "That version exists already: reload and try again." : error.message); }
    if (doImport) await runImport(tex, lang, items, onError, () => {});
    setBusy(false);
    onSaved();
  }

  return (
    <div className="register">
      <div className="row">
        <input type="file" accept=".tex,text/x-tex,text/plain"
               onChange={async (e) => { const f = e.target.files?.[0]; if (f) setTex(await f.text()); e.target.value = ""; }} />
        <span className="muted small">or paste it below</span>
      </div>
      <textarea rows={6} className="mono" placeholder="\documentclass… \begin{document} … \end{document}" value={tex} onChange={(e) => setTex(e.target.value)} />
      {summary && <p className={summary.ok ? "small" : "notice"}>{summary.text}</p>}
      <label className="check small">
        <input type="checkbox" checked={doImport} onChange={(e) => setDoImport(e.target.checked)} />
        Also import its content into the master CV (fills only empty {lang.toUpperCase()} fields; nothing is overwritten)
      </label>
      <div className="row">
        <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label="Language">
          <option value="de">German</option>
          <option value="en">English</option>
        </select>
        <input placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="primary small" disabled={!summary?.ok || busy} onClick={save}>Save as {lang.toUpperCase()} v{next}</button>
      </div>
    </div>
  );
}
