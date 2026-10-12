// Title families: the web mirror of pipeline/families.py (keep the two in step).
// core = digest + main feed; explore = only the Explore tab; off = not searched, titles don't pass.

export type FamilyMode = "core" | "explore" | "off";
export type Family = {
  key: string;
  label: string;
  mode: FamilyMode;
  titles: string[];
  exclude?: string[];
  search_terms: string[];
};

const re = (p: string): RegExp | null => { try { return new RegExp(p, "i"); } catch { return null; } };
const any = (patterns: string[] | undefined, title: string) => (patterns ?? []).some((p) => re(p)?.test(title));

export const familyMatches = (f: Family, title: string) => any(f.titles, title) && !any(f.exclude, title);

/** Core families win over explore ones; off families never match. */
export function classify(title: string, families: Family[]): Family | null {
  for (const mode of ["core", "explore"] as const) {
    const f = families.find((x) => x.mode === mode && familyMatches(x, title));
    if (f) return f;
  }
  return null;
}

export const activeTerms = (families: Family[]) =>
  [...new Set(families.filter((f) => f.mode !== "off").flatMap((f) => f.search_terms.map((t) => t.trim())).filter(Boolean))];
export const activeTitles = (families: Family[]) =>
  [...new Set(families.filter((f) => f.mode !== "off").flatMap((f) => f.titles))];

export const MODE_LABELS: Record<FamilyMode, string> = { core: "Core", explore: "Explore", off: "Off" };

/** Same rule as the pipeline's keyword_overlap: distinct skills of the owner mentioned in a text. */
export function skillOverlap(text: string | null, skills: Record<string, Record<string, string[]>>): string[] {
  if (!text) return [];
  const t = text.toLowerCase();
  const hits = new Set<string>();
  for (const track of Object.values(skills ?? {})) {
    for (const [canonical, aliases] of Object.entries(track ?? {})) {
      for (const a of [canonical, ...(aliases ?? [])]) {
        const alias = a.toLowerCase().trim().replace(/\s+/g, " ");
        if (alias.length < 2) continue;
        const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`(?<![\\p{L}\\p{N}_+#])${esc}(?![\\p{L}\\p{N}_+#])`, "u").test(t)) { hits.add(canonical); break; }
      }
    }
  }
  return [...hits];
}
