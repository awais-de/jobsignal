// StepStone email links (owner request 2026-10-19). Every link in a StepStone email is a click-tracking
// redirect to a magic *login* link for the owner's account ("…/v2/magiclink/exchange?magicLink=…&returnUrl=…"),
// and StepStone itself warns not to share them. Before the email is stored, each one is resolved by one
// redirect step only (the login link is never opened) and replaced by the plain job address from its
// returnUrl; any other link is dropped. That also keeps alert emails small: a single tracking link is
// ~1.7 KB, which used to fill the stored body before the last jobs.

const CLICK = /https?:\/\/click\.stepstone\.(?:de|com)\/[^\s<>()\[\]"']+/g;
const JOB_PATH = /^\/stellenangebote-[^?#]*?-(\d{6,})-inline\.html/;
export const UNRESOLVED_JOB_LINK = "[stepstone-link]";

export type Fetcher = (url: string) => Promise<{ status: number; location: string | null }>;

/** One redirect step, never followed (the next hop would log the account in). */
export const fetchRedirect: Fetcher = async (url) => {
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(6000) });
  await r.body?.cancel();
  return { status: r.status, location: r.headers.get("location") };
};

/** The plain job address a redirect target points to, or null when it isn't a job. */
export function jobUrlFromTarget(location: string | null): string | null {
  if (!location) return null;
  let u: URL;
  try { u = new URL(location, "https://www.stepstone.de"); } catch { return null; }
  const candidates = [u.pathname, u.searchParams.get("returnUrl") ?? "", u.searchParams.get("redirectUrl") ?? ""];
  for (const c of candidates) {
    let path = c;
    try { path = new URL(c, "https://www.stepstone.de").pathname; } catch { /* keep */ }
    const m = path.match(JOB_PATH);
    if (m) return `https://www.stepstone.de${m[0]}`;
  }
  return null;
}

export const isStepstone = (domain: string) => /(^|\.)stepstone\.(de|com)$/i.test(domain);

/** Replaces every StepStone tracking link: a job's by its plain address, any other by nothing. */
export async function cleanStepstoneLinks(text: string, fetcher: Fetcher = fetchRedirect, concurrency = 6): Promise<string> {
  const links = [...new Set(text.match(CLICK) ?? [])];
  if (!links.length) return text;
  const resolved = new Map<string, string>();
  for (let i = 0; i < links.length; i += concurrency) {
    await Promise.all(links.slice(i, i + concurrency).map(async (link) => {
      let job: string | null = null;
      let unresolved = false;
      try {
        const r = await fetcher(link);
        job = r.status >= 300 && r.status < 400 ? jobUrlFromTarget(r.location) : null;
        unresolved = !(r.status >= 300 && r.status < 400);
      } catch {
        unresolved = true;
      }
      // An unresolved link keeps its place (the parser needs the card's shape), never its token.
      resolved.set(link, job ?? (unresolved ? UNRESOLVED_JOB_LINK : ""));
    }));
  }
  return text.replace(CLICK, (l) => resolved.get(l) ?? "").replace(/[ \t]*<\s*>/g, "").replace(/\n{3,}/g, "\n\n");
}
