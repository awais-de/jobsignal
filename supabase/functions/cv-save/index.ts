// Owner-only: save a compiled CV build to Google Drive and register it as a resume version.
// POST { build_id, label? } → the PDF (private bucket cv-pdfs) goes to the Apps Script web app
// (APPS_SCRIPT_URL, shared INGEST_SECRET), which stores it in the Drive folder "Resumes" shared as
// "anyone with the link"; then a resumes row is created (UID, Drive link, text, LaTeX, job, base
// version) and, when the job has an application without a resume yet, attached to it.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APPS_SCRIPT_URL = Deno.env.get("APPS_SCRIPT_URL");
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init, headers: { ...svc, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`db ${init.method ?? "GET"} ${path.split("?")[0]} ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function isOwner(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const user = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: auth } });
  if (!user.ok) return false;
  const { id } = await user.json();
  const rows = await rest(`/app_owner?user_id=eq.${id}&select=user_id`);
  return Array.isArray(rows) && rows.length === 1;
}

/** R-YYMMDD-DE-1C-NN, the next free number for today (Berlin date). */
async function nextUid(lang: string): Promise<string> {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "2-digit", month: "2-digit", day: "2-digit" })
    .format(new Date()).replace(/-/g, "");
  const prefix = `R-${d}-${lang.toUpperCase()}-1C-`;
  const rows = await rest(`/resumes?uid=like.${encodeURIComponent(prefix)}*&select=uid`);
  const used = new Set((rows as { uid: string }[]).map((r) => Number(r.uid.slice(-2))));
  let n = 1;
  while (used.has(n)) n++;
  return `${prefix}${String(n).padStart(2, "0")}`;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await isOwner(req))) return json({ error: "forbidden" }, 403);
  if (!APPS_SCRIPT_URL || !INGEST_SECRET) return json({ error: "not_configured" }, 503);

  try {
    const body = await req.json().catch(() => ({}));
    const id = String(body?.build_id ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "bad_build_id" }, 400);
    const [b] = await rest(`/cv_builds?id=eq.${id}&select=*`);
    if (!b) return json({ error: "not_found" }, 404);
    if (b.status === "saved" && b.resume_id) return json({ error: "already_saved", resume_id: b.resume_id }, 409);
    if (b.status !== "compiled" || !b.pdf_path) return json({ error: "not_compiled" }, 409);

    const pdf = await fetch(`${SUPABASE_URL}/storage/v1/object/cv-pdfs/${b.pdf_path}`, { headers: svc });
    if (!pdf.ok) return json({ error: "pdf_missing" }, 500);
    const uid = await nextUid(b.lang);

    // Apps Script answers a POST with a redirect to the result; fetch follows it.
    const saved = await fetch(APPS_SCRIPT_URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, redirect: "follow",
      body: JSON.stringify({ secret: INGEST_SECRET, action: "save_cv", name: b.file_name, description: uid,
                             pdf: base64(new Uint8Array(await pdf.arrayBuffer())) }),
    });
    const drive = await saved.json().catch(() => ({ error: `apps_script_${saved.status}` }));
    if (!drive.id) return json({ error: "drive_failed", detail: drive.error ?? null }, 502);

    const [resume] = await rest("/resumes", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        uid, label: (body?.label ? String(body.label) : null)?.slice(0, 120) ?? null, language: b.lang,
        layout: "single_column", drive_file_id: drive.id, drive_url: drive.url, file_name: b.file_name,
        parse_status: "ok", extracted_text: b.plain_text, tex_source: b.tex_source,
        job_posting_id: b.job_posting_id, base_cv_id: b.base_cv_id,
      }),
    });
    await rest(`/cv_builds?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "saved", resume_id: resume.id }) });
    if (b.job_posting_id) {
      await rest(`/applications?job_posting_id=eq.${b.job_posting_id}&deleted_at=is.null&resume_id=is.null`, {
        method: "PATCH", body: JSON.stringify({ resume_id: resume.id }),
      });
    }
    return json({ ok: true, uid, resume_id: resume.id, drive_url: drive.url });
  } catch (e) {
    return json({ error: "failed", detail: e instanceof Error ? e.message : null }, 500);
  }
});
