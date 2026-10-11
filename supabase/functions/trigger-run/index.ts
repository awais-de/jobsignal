// Owner-only "Run now": starts the daily-pipeline workflow on GitHub (workflow_dispatch).
// The GitHub token never reaches the browser; it lives in the Supabase secret GITHUB_DISPATCH_TOKEN
// (fine-grained, this repo only, "Actions: read and write").

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = Deno.env.get("GITHUB_DISPATCH_TOKEN");
const REPO = Deno.env.get("GITHUB_REPO") ?? "awais-de/jobsignal";
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await isOwner(req))) return json({ error: "forbidden" }, 403);
  if (!TOKEN) return json({ error: "not_configured" }, 503);

  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/daily.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jobsignal",
    },
    body: JSON.stringify({ ref: "main", inputs: { dry_run: "false" } }),
  });
  // 204 = queued. Anything else: report the status only, never the token.
  if (res.status === 204) return json({ ok: true });
  return json({ error: "github_error", status: res.status }, 502);
});
