// Owner-only "Run now": starts the daily-pipeline workflow on GitHub (workflow_dispatch).
// The GitHub token never reaches the browser; it lives in the Supabase secret GITHUB_DISPATCH_TOKEN
// (fine-grained, this repo only, "Actions: read and write").

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = Deno.env.get("GITHUB_DISPATCH_TOKEN");
const REPO = Deno.env.get("GITHUB_REPO") ?? "awais-de/jobsignal";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function isOwner(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const user = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: auth } });
  if (!user.ok) return false;
  const { id } = await user.json();
  const rows = await (await fetch(`${SUPABASE_URL}/rest/v1/app_owner?user_id=eq.${id}&select=user_id`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })).json();
  return Array.isArray(rows) && rows.length === 1;
}

/** Constant-time comparison for the cron secret. */
function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  // Supabase's daily scheduler (pg_cron, migration ..._daily_cron.sql) authenticates with CRON_SECRET and
  // can only start the daily run, marked scheduled (skipped if today already ran).
  const cron = safeEqual(req.headers.get("x-cron-secret") ?? "", CRON_SECRET);
  if (!cron && !(await isOwner(req))) return json({ error: "forbidden" }, 403);
  if (!TOKEN) return json({ error: "not_configured" }, 503);

  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "jobsignal",
  };
  // { workflow: "rerank" } re-ranks stored jobs after a profile save (no fetch, no email);
  // anything else starts the daily pipeline. Only these three workflows can be started.
  const raw = await req.json().catch(() => ({}));
  const body = cron ? { workflow: "daily" } : raw;
  // { workflow: "cv", build_id } compiles one CV build (cv.yml); the id must be an existing build.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (body?.workflow === "cv" && !UUID.test(String(body?.build_id ?? ""))) return json({ error: "bad_build_id" }, 400);
  const file = body?.workflow === "rerank" ? "rerank.yml" : body?.workflow === "cv" ? "cv.yml" : "daily.yml";
  const workflow = `https://api.github.com/repos/${REPO}/actions/workflows/${file}`;

  // { check: true } verifies the token without starting a run.
  if (body?.check) {
    const res = await fetch(workflow, { headers });
    return res.ok ? json({ ok: true, check: true }) : json({ error: "github_error", status: res.status }, 502);
  }

  const res = await fetch(`${workflow}/dispatches`, {
    method: "POST",
    headers,
    body: JSON.stringify(file === "daily.yml"
      ? { ref: "main", inputs: { dry_run: "false", scheduled: cron ? "true" : "false" } }
      : file === "cv.yml" ? { ref: "main", inputs: { build_id: body.build_id } } : { ref: "main" }),
  });
  // 204 = queued. Anything else: report the status only, never the token.
  if (res.status === 204) return json({ ok: true });
  return json({ error: "github_error", status: res.status }, 502);
});
