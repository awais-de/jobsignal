// Port of pipeline/normalize.py (company and title only) for email matching.
// Keep in sync: tests in normalize_test.ts use the same vectors as tests/test_normalize.py.

const LEGAL_FORMS = [
  "gmbh & co. kgaa", "gmbh & co. kg", "gmbh & co kg", "ag & co. kg", "se & co. kg",
  "gmbh", "mbh", "ag", "se", "kg", "kgaa", "ug (haftungsbeschränkt)", "ug", "ohg", "gbr",
  "e.v.", "ev", "e.g.", "eg", "inc.", "inc", "ltd.", "ltd", "llc", "b.v.", "bv", "s.a.", "sa",
  "plc", "corp.", "corp", "co.",
].sort((a, b) => b.length - a.length);

const BRANCH_SUFFIX = /\b(niederlassung|standort|zweigniederlassung|filiale|branch)\b.*$/u;
const GENDER_MARKERS =
  /\(\s*(?:[mwfdxi]\s*[/|,\s]\s*){1,3}[mwfdxi]\s*\)|\(\s*all genders?\s*\)|\(\s*gn\s*\)|\(\s*d\s*\)|\*in(?:nen)?\b|:in(?:nen)?\b|\/-?in(?:nen)?\b|_in(?:nen)?\b/giu;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const collapse = (s: string) => s.replace(/\s+/gu, " ").trim();
const stripPunct = (s: string) => [...s].map((ch) => (/[\p{L}\p{N}\s]/u.test(ch) ? ch : " ")).join("");

export function normalizeCompany(name: string): string {
  let s = name.normalize("NFC").toLowerCase().replace(BRANCH_SUFFIX, "");
  let changed = true;
  while (changed) {
    changed = false;
    for (const form of LEGAL_FORMS) {
      const re = new RegExp(`(?:^|[\\s,])${escape(form)}(?=$|[\\s,])`, "gu");
      const next = s.replace(re, " ");
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
  }
  return collapse(stripPunct(s));
}

export function normalizeTitle(title: string): string {
  return collapse(stripPunct(title.normalize("NFC").replace(GENDER_MARKERS, " ").toLowerCase()));
}

/** Token-set similarity in [0, 1]: |A∩B| / max(|A|, |B|) on normalized title words. */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeTitle(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeTitle(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

/** Company names match if equal after normalization, or one contains the other as whole words. */
export function sameCompany(a: string, b: string): boolean {
  const na = normalizeCompany(a), nb = normalizeCompany(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  // Short names (DIS, VHV, SAP) only as the leading word(s): "dis" = "dis germany", not "paradis".
  if (short.length < 4) return short.length >= 3 && long.startsWith(short + " ");
  return new RegExp(`(^| )${escape(short)}( |$)`, "u").test(long);
}
