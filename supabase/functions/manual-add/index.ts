// Manual add (spec 9.3): paste a job URL or text → extracted fields → one action creates the
// posting, the application (with JD snapshot) and the 'applied' event.
//
// POST, owner session required (Authorization: Bearer <access token>):
//   { op: "analyse", url?, text? }  -> { fields, description, url }
//   { op: "save", posting: {...}, applied_at?, resume_id? } -> { application_id, job_posting_id }
//
// Extraction uses the same prompt and schema as the daily pipeline (_shared/jd_extraction.json).

import shared from "../_shared/jd_extraction.json" with { type: "json" };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GROQ_KEY = Deno.env.get("GROQ_API_KEY");
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const MAX_CHARS = 8000;

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function rest(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function isOwner(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const user = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: auth } });
  if (!user.ok) return false;
  const { id } = await user.json();
  const rows = await (await rest(`/app_owner?user_id=eq.${id}&select=user_id`)).json();
  return Array.isArray(rows) && rows.length === 1;
}

// ---- fetching a posting -------------------------------------------------------

function allowedUrl(raw: string): URL | string {
  let u: URL;
  try { u = new URL(raw); } catch { return "invalid_url"; }
  if (!["http:", "https:"].includes(u.protocol)) return "invalid_url";
  const host = u.hostname.toLowerCase();
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin"; // spec: never fetch LinkedIn
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host.includes(":")) {
    return "invalid_url";
  }
  return u;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|li|h[1-6]|div|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n").trim();
}

type JobLd = { title?: string; company?: string; city?: string; description?: string };

function jobPostingJsonLd(html: string): JobLd | null {
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, raw] of blocks) {
    let data: unknown;
    try { data = JSON.parse(raw.trim()); } catch { continue; }
    const items = ([] as unknown[]).concat(data, (data as { "@graph"?: unknown[] })?.["@graph"] ?? []);
    for (const it of items as Record<string, any>[]) {
      const type = it?.["@type"];
      if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) {
        const loc = Array.isArray(it.jobLocation) ? it.jobLocation[0] : it.jobLocation;
        return {
          title: it.title,
          company: typeof it.hiringOrganization === "string" ? it.hiringOrganization : it.hiringOrganization?.name,
          city: loc?.address?.addressLocality,
          description: it.description ? htmlToText(String(it.description)) : undefined,
        };
      }
    }
  }
  return null;
}

async function fetchPosting(u: URL): Promise<{ text: string; ld: JobLd | null }> {
  const res = await fetch(u, {
    headers: { "User-Agent": "jobsignal/0.1 (personal job search)", Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`fetch_${res.status}`);
  const html = (await res.text()).slice(0, 2_000_000);
  const ld = jobPostingJsonLd(html);
  return { text: ld?.description ?? htmlToText(html), ld };
}

// ---- extraction -----------------------------------------------------------------

const MANUAL_SCHEMA = (() => {
  const s = structuredClone(shared.schema) as Record<string, any>;
  for (const k of ["title", "company_name", "city"]) {
    s.properties[k] = { type: ["string", "null"] };
    s.required.push(k);
  }
  return s;
})();

const MANUAL_SYSTEM = shared.system +
  " Also extract: title = the job title; company_name = the hiring company (not a job board or " +
  "recruiting platform); city = the main work location city.";

async function extract(text: string): Promise<{ data: Record<string, any>; model: string } | { error: string }> {
  if (!GROQ_KEY) return { error: "llm_not_configured" };
  for (const model of GROQ_MODELS) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: MANUAL_SYSTEM }, { role: "user", content: `Posting:\n${text}` }],
        response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema: MANUAL_SCHEMA } },
        max_completion_tokens: 1500, temperature: 0, reasoning_effort: "low",
      }),
      signal: AbortSignal.timeout(60000),
    }).catch(() => null);
    if (!res) continue;
    if (res.status === 429 || res.status >= 500) continue;   // try the next model
    if (!res.ok) return { error: `llm_http_${res.status}` };
    try {
      const body = await res.json();
      return { data: JSON.parse(body.choices[0].message.content), model: `groq:${model}` };
    } catch {
      return { error: "llm_unparseable" };
    }
  }
  return { error: "llm_unavailable" };
}

// ---- save -----------------------------------------------------------------------

const POSTING_FIELDS = [
  "title", "company_name", "city", "description", "must_have_skills", "nice_to_have_skills", "seniority",
  "required_years", "german_level", "english_level", "contract_type", "remote_policy", "named_contact",
  "reference_number", "start_date_text", "salary_text", "specificity_score", "evergreen_language",
  "extraction_model",
];

async function save(body: Record<string, any>) {
  const p = body.posting ?? {};
  if (!p.title?.trim() || !p.company_name?.trim()) return json({ error: "title_and_company_required" }, 400);
  const row: Record<string, unknown> = {};
  for (const k of POSTING_FIELDS) if (p[k] !== undefined && p[k] !== "") row[k] = p[k];
  const url = typeof p.url === "string" && p.url ? p.url : null;
  const now = new Date().toISOString();
  const appliedAt = body.applied_at ? new Date(body.applied_at).toISOString() : now;

  const posting = await rest("/job_postings", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      ...row,
      // The daily pipeline replaces this placeholder with the real dedupe hash.
      dedupe_hash: `manual:${crypto.randomUUID()}`,
      source: "manual", source_url: url, apply_url: url, country: "DE",
      description_missing: !p.description,
      extraction_status: p.extraction_model ? "done" : "skipped",
      filter_status: "passed", triage_status: "applied", triaged_at: now,
    }),
  });
  if (!posting.ok) return json({ error: "save_posting_failed" }, 500);
  const [{ id: postingId }] = await posting.json();

  const app = await rest("/applications", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      job_posting_id: postingId, origin: "manual", jd_snapshot: p.description ?? null,
      applied_at: appliedAt, resume_id: body.resume_id || null,
    }),
  });
  if (!app.ok) return json({ error: "save_application_failed" }, 500);
  const [{ id: appId }] = await app.json();

  await rest("/application_events", {
    method: "POST",
    body: JSON.stringify({ application_id: appId, event_type: "applied", source: "user", occurred_at: appliedAt }),
  });
  return json({ application_id: appId, job_posting_id: postingId });
}

// ---- handler ----------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await isOwner(req))) return json({ error: "forbidden" }, 403);

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  if (body.op === "save") return save(body);
  if (body.op !== "analyse") return json({ error: "bad_request" }, 400);

  let text = typeof body.text === "string" ? body.text.trim() : "";
  let ld: JobLd | null = null;
  let url: string | null = null;
  if (!text && body.url) {
    const u = allowedUrl(String(body.url));
    if (typeof u === "string") return json({ error: u }, 400);
    url = u.toString();
    try {
      ({ text, ld } = await fetchPosting(u));
    } catch {
      return json({ error: "fetch_failed" }, 502);
    }
  } else if (body.url) {
    url = String(body.url);
  }
  if (text.length < 80) return json({ error: "too_little_text" }, 400);
  text = text.slice(0, MAX_CHARS);

  const result = await extract(text);
  if ("error" in result) {
    // Still useful: return what structured data gave us, so the owner can save by hand.
    return json({ error: result.error, fields: { title: ld?.title ?? null, company_name: ld?.company ?? null,
                  city: ld?.city ?? null }, description: text, url }, 200);
  }
  const f = result.data;
  const spec = f.specificity ?? {};
  return json({
    fields: {
      ...f,
      // Structured data from the page beats the model for identity fields.
      title: ld?.title ?? f.title, company_name: ld?.company ?? f.company_name, city: ld?.city ?? f.city,
      specificity_score: ["named_team", "concrete_project", "named_manager"].filter((k) => spec[k]).length,
      extraction_model: result.model,
    },
    description: text,
    url,
  });
});
