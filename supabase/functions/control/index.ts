// Control panel backend (owner request 2026-10-14). POST { action? }:
//   (none) | "snapshot"  gather the app's status, compute warnings, store a snapshot, return both
//   "purge_cv"           delete compiled CV PDFs never saved to Drive (older than 14 days)
// Owner session, or the daily cron (x-cron-secret) for "snapshot". Secrets are reported as present or
// missing, never their values. Optional sources switch on when their key is set: HEALTHCHECKS_API_KEY
// (read-only key), SUPABASE_ACCESS_TOKEN (management API, project status).
import { type Status, warnings, FREE_LIMITS, EXPECTED_BRIDGE_VERSION } from "../_shared/control/warnings.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = Deno.env.get("GITHUB_DISPATCH_TOKEN");
const REPO = Deno.env.get("GITHUB_REPO") ?? "awais-de/jobsignal";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const APPS_SCRIPT_URL = Deno.env.get("APPS_SCRIPT_URL");
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? "";
const HEALTHCHECKS_API_KEY = Deno.env.get("HEALTHCHECKS_API_KEY");
const SUPABASE_ACCESS_TOKEN = Deno.env.get("SUPABASE_ACCESS_TOKEN");
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers: { ...svc, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path.split("?")[0]} ${res.status}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function isOwner(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const user = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: auth } });
  if (!user.ok) return false;
  const { id } = await user.json();
  const rows = await rest(`/rest/v1/app_owner?user_id=eq.${id}&select=user_id`);
  return Array.isArray(rows) && rows.length === 1;
}

const timed = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);

/** "2026-11-12 10:00:00 UTC" or "2026-11-12 10:00:00 +0100" → ISO; null when absent or unreadable. */
function parseExpiry(exp: string | null): string | null {
  if (!exp) return null;
  for (const t of [exp.replace(" UTC", "Z").replace(" ", "T"), exp.replace(" ", "T").replace(/ ([+-]\d{2})(\d{2})$/, "$1:$2"), exp]) {
    const d = new Date(t);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

async function github(): Promise<Status["github"] & { latest_commit?: string | null }> {
  if (!TOKEN) return { configured: false, ok: false, workflows: [], failures_24h: [] };
  const h = { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "jobsignal" };
  const res = await timed(fetch(`https://api.github.com/repos/${REPO}/actions/runs?per_page=50`, { headers: h }), 10000);
  // Fine-grained tokens report their expiry with every response.
  const exp = res.headers.get("github-authentication-token-expiration");
  if (!res.ok) return { configured: true, ok: false, error: `HTTP ${res.status}`, token_expires: exp, workflows: [], failures_24h: [] };
  const runs = ((await res.json()).workflow_runs ?? []) as { name: string; status: string; conclusion: string | null; created_at: string; html_url: string }[];
  const latest = new Map<string, Status["github"]["workflows"][number]>();
  for (const r of runs) if (!latest.has(r.name)) latest.set(r.name, { name: r.name, status: r.status, conclusion: r.conclusion, created_at: r.created_at, url: r.html_url });
  const since = Date.now() - 86400_000;
  const failures_24h = runs.filter((r) => r.conclusion === "failure" && new Date(r.created_at).getTime() > since)
    .map((r) => ({ name: r.name, created_at: r.created_at, url: r.html_url }));
  let latest_commit: string | null = null;
  try {
    const c = await timed(fetch(`https://api.github.com/repos/${REPO}/commits/main`, { headers: h }), 8000);
    if (c.ok) latest_commit = String((await c.json()).sha ?? "").slice(0, 7) || null;
  } catch { /* optional */ }
  return { configured: true, ok: true, token_expires: parseExpiry(exp),
           workflows: [...latest.values()], failures_24h, latest_commit };
}

async function drive(): Promise<Status["drive"]> {
  if (!APPS_SCRIPT_URL || !INGEST_SECRET) return { configured: false };
  try {
    const res = await timed(fetch(APPS_SCRIPT_URL, { method: "POST", redirect: "follow", headers: { "Content-Type": "application/json" },
                                                     body: JSON.stringify({ secret: INGEST_SECRET, action: "ping" }) }), 15000);
    const b = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!b.ok) return { configured: true, ok: false, error: b.error ?? "no answer" };
    return { configured: true, ok: true, version: b.version, folder: b.folder, folder_error: b.folder_error };
  } catch (e) {
    return { configured: true, ok: false, error: e instanceof Error ? e.message : "error" };
  }
}

async function healthchecks(): Promise<NonNullable<Status["healthchecks"]>> {
  if (!HEALTHCHECKS_API_KEY) return { configured: false };
  try {
    const res = await timed(fetch("https://healthchecks.io/api/v3/checks/", { headers: { "X-Api-Key": HEALTHCHECKS_API_KEY } }), 8000);
    if (!res.ok) return { configured: true, error: `HTTP ${res.status}` };
    const checks = ((await res.json()).checks ?? []) as { name: string; status: string; last_ping: string | null }[];
    return { configured: true, checks: checks.map((c) => ({ name: c.name, status: c.status, last_ping: c.last_ping })) };
  } catch (e) {
    return { configured: true, error: e instanceof Error ? e.message : "error" };
  }
}

async function project(): Promise<NonNullable<Status["project"]>> {
  if (!SUPABASE_ACCESS_TOKEN) return { configured: false };
  try {
    const res = await timed(fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}`, { headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}` } }), 8000);
    if (!res.ok) return { configured: true, error: `HTTP ${res.status}` };
    return { configured: true, status: (await res.json()).status };
  } catch (e) {
    return { configured: true, error: e instanceof Error ? e.message : "error" };
  }
}

async function gather() {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [db, gh, dr, hc, pr, limited] = await Promise.all([
    rest("/rest/v1/rpc/control_status", { method: "POST", body: "{}" }),
    github().catch((e) => ({ configured: !!TOKEN, ok: false, error: e instanceof Error ? e.message : "error", workflows: [], failures_24h: [] })),
    drive(), healthchecks(), project(),
    rest(`/rest/v1/llm_usage?select=created_at&error=eq.rate_limited&created_at=gte.${since}`),
  ]);
  const llm = { rate_limited_days: new Set((limited as { created_at: string }[]).map((r) => r.created_at.slice(0, 10))).size };
  const status = {
    db, github: gh, drive: dr, healthchecks: hc, project: pr, llm,
    config: {
      GITHUB_DISPATCH_TOKEN: !!TOKEN, CRON_SECRET: !!CRON_SECRET, INGEST_SECRET: !!INGEST_SECRET,
      APPS_SCRIPT_URL: !!APPS_SCRIPT_URL, HEALTHCHECKS_API_KEY: !!HEALTHCHECKS_API_KEY, SUPABASE_ACCESS_TOKEN: !!SUPABASE_ACCESS_TOKEN,
    },
    limits: FREE_LIMITS, expected_bridge_version: EXPECTED_BRIDGE_VERSION,
  };
  return { status, warnings: warnings(status as unknown as Status) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const cron = safeEqual(req.headers.get("x-cron-secret") ?? "", CRON_SECRET);
  if (!cron && !(await isOwner(req))) return json({ error: "forbidden" }, 403);
  const body = await req.json().catch(() => ({}));

  try {
    if (body?.action === "purge_cv" && !cron) {
      const old = await rest("/rest/v1/rpc/unsaved_cv_pdfs", { method: "POST", body: JSON.stringify({ p_days: 14 }) }) as { id: string; pdf_path: string }[];
      if (old.length) {
        await rest("/storage/v1/object/cv-pdfs", { method: "DELETE", body: JSON.stringify({ prefixes: old.map((o) => o.pdf_path) }) });
        await rest(`/rest/v1/cv_builds?id=in.(${old.map((o) => o.id).join(",")})`, { method: "PATCH", body: JSON.stringify({ pdf_path: null }) });
      }
      return json({ ok: true, deleted: old.length });
    }
    const result = await gather();
    await rest("/rest/v1/control_snapshots", { method: "POST", body: JSON.stringify(result) });
    // Keep a month of snapshots.
    await rest(`/rest/v1/control_snapshots?created_at=lt.${new Date(Date.now() - 30 * 86400_000).toISOString()}`, { method: "DELETE" });
    return json(result);
  } catch (e) {
    return json({ error: "failed", detail: e instanceof Error ? e.message : null }, 500);
  }
});
