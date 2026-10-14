import { useEffect, useMemo, useState } from "react";
import { classify, MODE_LABELS, type Family, type FamilyMode } from "./families";
import { saveProfile } from "./profileStore";
import { BaseCvs } from "./CvBase";
import { ConnectionsImport } from "./Outreach";
import { supabase } from "./supabase";

// The owner's profile, edited here instead of a YAML file. The pipeline reads it on every run;
// skill changes also re-rank stored jobs (no LLM calls needed).

type Skills = Record<string, Record<string, string[]>>;           // track -> canonical -> aliases
type Company = { name: string; technique: string; url?: string; link_pattern?: string; filters?: string };
type Profile = {
  search_terms: string[];
  titles: { allow: string[]; block: string[] };
  dealbreakers: { max_required_years: number; max_german_level: string };
  contract_types: string[];
  skills: Skills;
  watchlist?: Company[];
  outreach?: { sender_name?: string };
  families?: Family[];
  [key: string]: unknown;
};

const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];
const CONTRACTS = ["full_time", "part_time", "werkstudent", "internship", "thesis", "freelance"];
const TECHNIQUES = ["career_page", "cornerstone"];
const FILTERS: Record<string, string> = { all: "Your filters", watch: "All titles (block list applies)", none: "No filters" };

function badPattern(p: string): boolean {
  try { new RegExp(p, "i"); return false; } catch { return true; }
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [version, setVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("owner_profile").select("profile,version").eq("id", 1).maybeSingle().then(({ data, error }) => {
      if (error) return setError(error.message);
      if (!data) return setError("No profile stored yet.");
      setProfile(data.profile as Profile);
      setSaved(JSON.stringify(data.profile));
      setVersion(data.version);
    });
  }, []);

  const dirty = profile !== null && JSON.stringify(profile) !== saved;
  const invalid = profile ? [...profile.titles.allow, ...profile.titles.block,
    ...(profile.families ?? []).flatMap((f) => [...f.titles, ...(f.exclude ?? [])])].filter(badPattern) : [];

  async function save() {
    if (!profile || invalid.length) return;
    setBusy(true);
    try {
      const r = await saveProfile(profile);
      setProfile(r.profile);
      setSaved(JSON.stringify(r.profile));
      setVersion(r.version);
      setError(null);
      setNote(r.note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Saving failed.");
    }
    setBusy(false);
  }

  if (!profile) return <p className="empty">{error ?? "Loading…"}</p>;
  const set = (patch: Partial<Profile>) => setProfile({ ...profile, ...patch });

  return (
    <div className="profile">
      <div className="profile-bar">
        <h2>Profile</h2>
        <span className="muted">
          {dirty ? "Unsaved changes" : `Saved · version ${version}`}. Saving re-ranks existing jobs within about a minute;
          title and dealbreaker changes apply to new jobs from the next run ("Run now" applies them immediately).
        </span>
        <button className="primary" disabled={!dirty || busy || invalid.length > 0} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <p className="notice">{error}</p>}
      {note && !dirty && <p className="notice">{note}</p>}
      {invalid.length > 0 && <p className="notice">Fix the highlighted title patterns before saving.</p>}

      <section className="card">
        <h3>Target roles</h3>
        <TitleTester allow={profile.titles.allow} block={profile.titles.block} families={profile.families} />
        {profile.families?.length ? (
          <FamiliesEditor families={profile.families} onChange={(families) => set({ families })} />
        ) : (
          <>
            <ListEditor label="Titles to include" hint="A job title must match at least one. Plain words work; regular expressions too, e.g. \bdata\b.*engineer"
                        items={profile.titles.allow} invalid={badPattern}
                        onChange={(allow) => set({ titles: { ...profile.titles, allow } })} />
            <ListEditor label="Arbeitsagentur search terms" hint="Free-text searches sent to the Arbeitsagentur, Workday and SmartRecruiters. Broad is fine: the title lists do the filtering."
                        items={profile.search_terms} onChange={(search_terms) => set({ search_terms })} />
          </>
        )}
        <ListEditor label="Titles to exclude (all families)" hint="A job title matching any of these is dropped (also at watched companies)."
                    items={profile.titles.block} invalid={badPattern}
                    onChange={(block) => set({ titles: { ...profile.titles, block } })} />
      </section>

      <section className="card">
        <h3>Dealbreakers</h3>
        <div className="row">
          <label>Max years of experience required
            <input type="number" min={0} max={15} step={0.5} value={profile.dealbreakers.max_required_years}
                   onChange={(e) => set({ dealbreakers: { ...profile.dealbreakers, max_required_years: Number(e.target.value) } })} />
          </label>
          <label>Highest German level a job may require
            <select value={profile.dealbreakers.max_german_level}
                    onChange={(e) => set({ dealbreakers: { ...profile.dealbreakers, max_german_level: e.target.value } })}>
              {CEFR.map((l) => <option key={l}>{l}</option>)}
            </select>
          </label>
        </div>
        <div className="row checks">
          <span className="muted">Contract types:</span>
          {CONTRACTS.map((c) => (
            <label key={c} className="check">
              <input type="checkbox" checked={profile.contract_types.includes(c)}
                     onChange={(e) => set({ contract_types: e.target.checked
                       ? [...profile.contract_types, c] : profile.contract_types.filter((x) => x !== c) })} />
              {c.replace("_", " ")}
            </label>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>Skills</h3>
        <p className="muted">
          Your skills live in the <a href="#skills">skills database</a> (Skills page): ratings, variants and the names job ads use. Ranking and
          the skills section of your CVs read them from there. The list kept in this profile is only a fallback for the pipeline.
        </p>
      </section>

      <section className="card">
        <h3>Reaching out</h3>
        <div className="row">
          <label>Your name, as it appears in pings ("Hi Anna, I'm …")
            <input value={profile.outreach?.sender_name ?? ""} placeholder="First name"
                   onChange={(e) => set({ outreach: { ...profile.outreach, sender_name: e.target.value } })} />
          </label>
        </div>
      </section>
      <ConnectionsImport />
      <BaseCvs />

      <section className="card">
        <h3>Watched companies</h3>
        <p className="muted">Checked on every run. Companies found automatically are managed separately.</p>
        <WatchlistEditor items={profile.watchlist ?? []} onChange={(watchlist) => set({ watchlist })} />
      </section>
    </div>
  );
}

function ListEditor({ label, hint, items, onChange, invalid }: {
  label: string; hint: string; items: string[]; onChange: (v: string[]) => void; invalid?: (s: string) => boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !items.includes(v)) onChange([...items, v]);
    setDraft("");
  };
  return (
    <div className="list-editor">
      <div className="label">{label}</div>
      <div className="muted small">{hint}</div>
      <div className="chips">
        {items.map((it) => (
          <span key={it} className={`chip-item${invalid?.(it) ? " bad" : ""}`} title={invalid?.(it) ? "Invalid pattern" : undefined}>
            <code>{it}</code>
            <button className="x" aria-label={`Remove ${it}`} onClick={() => onChange(items.filter((x) => x !== it))}>×</button>
          </span>
        ))}
      </div>
      <div className="row">
        <input value={draft} placeholder="Add…" onChange={(e) => setDraft(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="small" disabled={!draft.trim()} onClick={add}>Add</button>
      </div>
    </div>
  );
}

function TitleTester({ allow, block, families }: { allow: string[]; block: string[]; families?: Family[] }) {
  const [title, setTitle] = useState("");
  const result = useMemo(() => {
    if (!title.trim()) return null;
    const test = (p: string) => { try { return new RegExp(p, "i").test(title); } catch { return false; } };
    const blocked = block.find(test);
    if (blocked) return { ok: false, text: `Excluded by “${blocked}”` };
    if (families?.length) {
      const f = classify(title, families);
      return f ? { ok: true, text: `Passes: ${f.label} (${MODE_LABELS[f.mode]})` } : { ok: false, text: "No active family matches" };
    }
    const allowed = allow.find(test);
    return allowed ? { ok: true, text: `Passes (matches “${allowed}”)` } : { ok: false, text: "No include pattern matches" };
  }, [title, allow, block]);
  return (
    <div className="tester">
      <input placeholder="Test a job title, e.g. Senior Data Engineer (m/w/d)" value={title} onChange={(e) => setTitle(e.target.value)} />
      {result && <span className={`status status-${result.ok ? "green" : "red"}`}>{result.text}</span>}
    </div>
  );
}

/** Title families: what is searched and which titles pass, each Core / Explore / Off. */
function FamiliesEditor({ families, onChange }: { families: Family[]; onChange: (f: Family[]) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const put = (i: number, patch: Partial<Family>) => onChange(families.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const add = () => {
    const label = window.prompt("Name of the new family, e.g. Reporting");
    if (!label?.trim()) return;
    const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (families.some((f) => f.key === key)) return;
    onChange([...families, { key, label: label.trim(), mode: "explore", titles: [], exclude: [], search_terms: [] }]);
    setOpen(key);
  };
  return (
    <div className="families">
      <p className="muted">
        <strong>Core</strong>: digest and main feed. <strong>Explore</strong>: searched and ranked the same way, shown only in the
        feed's Explore tab. <strong>Off</strong>: not searched. Changing a family also re-checks jobs from the last two weeks.
      </p>
      {families.map((f, i) => (
        <div key={f.key} className={`family family-${f.mode}`}>
          <div className="family-head">
            <button className="link" onClick={() => setOpen(open === f.key ? null : f.key)} aria-expanded={open === f.key}>
              {open === f.key ? "▾" : "▸"} <strong>{f.label}</strong>
            </button>
            <span className="muted small">{f.titles.length} title patterns · {f.search_terms.length} search terms</span>
            <select value={f.mode} onChange={(e) => put(i, { mode: e.target.value as FamilyMode })} aria-label={`Mode of ${f.label}`}>
              {Object.entries(MODE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          {open === f.key && (
            <div className="family-body">
              <ListEditor label="Titles" hint="A title matching any of these belongs to this family (regular expressions work)."
                          items={f.titles} invalid={badPattern} onChange={(titles) => put(i, { titles })} />
              <ListEditor label="Search terms" hint="Sent to the Arbeitsagentur, Workday and SmartRecruiters while the family isn't Off."
                          items={f.search_terms} onChange={(search_terms) => put(i, { search_terms })} />
              <ListEditor label="Except titles matching" hint="Titles matching these don't count for this family."
                          items={f.exclude ?? []} invalid={badPattern} onChange={(exclude) => put(i, { exclude })} />
              <button className="link danger" onClick={() => window.confirm(`Remove the family “${f.label}”?`) && onChange(families.filter((_, j) => j !== i))}>
                Remove family
              </button>
            </div>
          )}
        </div>
      ))}
      <button className="small" onClick={add}>+ Add a family</button>
    </div>
  );
}

function WatchlistEditor({ items, onChange }: { items: Company[]; onChange: (v: Company[]) => void }) {
  const update = (i: number, patch: Partial<Company>) => onChange(items.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <>
      {items.map((c, i) => (
        <div key={i} className="watch-row">
          <input value={c.name} placeholder="Company" onChange={(e) => update(i, { name: e.target.value })} />
          <select value={c.technique} onChange={(e) => update(i, { technique: e.target.value })}>
            {TECHNIQUES.map((t) => <option key={t}>{t}</option>)}
          </select>
          <input className="grow" value={c.url ?? ""} placeholder="Careers page or sitemap.xml URL" onChange={(e) => update(i, { url: e.target.value })} />
          {c.technique === "career_page" && (
            <input value={c.link_pattern ?? ""} placeholder="Job link pattern, e.g. /job/" onChange={(e) => update(i, { link_pattern: e.target.value })} />
          )}
          <select value={c.filters ?? "watch"} onChange={(e) => update(i, { filters: e.target.value })}>
            {Object.entries(FILTERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button className="link danger" onClick={() => onChange(items.filter((_, j) => j !== i))}>remove</button>
        </div>
      ))}
      <button className="small" onClick={() => onChange([...items, { name: "", technique: "career_page", url: "", link_pattern: "/job/", filters: "all" }])}>
        + Add company
      </button>
      <p className="muted small">Not sure which technique or link pattern a site needs? Ask Claude to check the careers page.</p>
    </>
  );
}
