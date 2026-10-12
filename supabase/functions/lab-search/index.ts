// Owner-only "Title lab" probe: one Arbeitsagentur search for a term the owner is considering,
// returning the total and a sample of titles. Same API and parameters as the pipeline
// (pipeline/sources/ba.py): full-time jobs, published in the last N days. Nothing is stored or logged.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const BA_SEARCH = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs";

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

  const body = await req.json().catch(() => ({}));
  const term = typeof body?.term === "string" ? body.term.trim().slice(0, 100) : "";
  const days = Math.min(Math.max(Number(body?.days) || 7, 1), 30);
  if (!term) return json({ error: "term_required" }, 400);

  const params = new URLSearchParams({
    was: term, angebotsart: "1", arbeitszeit: "vz", veroeffentlichtseit: String(days), page: "1", size: "50",
  });
  const res = await fetch(`${BA_SEARCH}?${params}`, {
    headers: { "X-API-Key": "jobboerse-jobsuche", Accept: "application/json",
               "User-Agent": "jobsignal/0.1 (personal job search; github.com/awais-de/jobsignal)" },
  });
  if (!res.ok) return json({ error: "ba_error", status: res.status }, 502);
  const data = await res.json();
  const items = (data.ergebnisliste ?? []) as Record<string, any>[];
  return json({
    term, days,
    total: Number(data.maxErgebnisse ?? items.length),
    // Field names as in pipeline/sources/ba.py parse_search_item.
    items: items.map((i) => ({
      title: i.stellenangebotsTitel ?? i.hauptberuf ?? "",
      company: i.firma ?? "",
      city: (i.stellenlokationen ?? []).map((l: any) => l?.adresse?.ort).find(Boolean) ?? null,
      posted: i.datumErsteVeroeffentlichung ?? null,
      url: i.referenznummer ? `https://www.arbeitsagentur.de/jobsuche/jobdetail/${i.referenznummer}` : null,
    })),
  });
});
