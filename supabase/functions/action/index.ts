// Action links from the digest (spec 7.10).
//
// The email links to the web app's /a page, which calls this function. Only
// POST is accepted, so link scanners that fetch URLs can't trigger anything:
//   { op: "peek",    token }          -> what the link would do (changes nothing)
//   { op: "confirm", token, reason? } -> performs it once; reused tokens are rejected
//
// Token: base64url("<posting_id>.<action>.<expiry_unix>") + "." + base64url(HMAC-SHA256)
// signed with ACTION_LINK_SECRET (shared with the pipeline).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("ACTION_LINK_SECRET")!;
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const ACTIONS = new Set(["apply", "skip"]);
const SKIP_REASONS = new Set([
  "too_senior", "wrong_stack", "language", "location", "contract_type",
  "not_interesting", "looks_fake", "other",
]);

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

type Parsed = { postingId: string; action: string; expiry: number };

async function verify(token: string): Promise<Parsed | { error: string }> {
  const [p, s] = String(token ?? "").split(".");
  if (!p || !s) return { error: "invalid" };
  let payload: string;
  try {
    payload = new TextDecoder().decode(b64urlDecode(p));
  } catch {
    return { error: "invalid" };
  }
  if (!timingSafeEqual(await hmac(payload), b64urlDecode(s))) return { error: "invalid" };
  const [postingId, action, exp] = payload.split(".");
  const expiry = Number(exp);
  if (!postingId || !ACTIONS.has(action) || !Number.isFinite(expiry)) return { error: "invalid" };
  if (Date.now() / 1000 > expiry) return { error: "expired" };
  return { postingId, action, expiry };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return b64urlEncode(new Uint8Array(digest));
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { op?: string; token?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const parsed = await verify(body.token ?? "");
  if ("error" in parsed) return json({ error: parsed.error }, 400);
  const tokenHash = await sha256(body.token!);

  if (body.op === "peek") {
    const [postingRes, usedRes] = await Promise.all([
      rest(`/job_postings?id=eq.${parsed.postingId}&deleted_at=is.null` +
        `&select=title,company_name,city,triage_status,skip_reason,apply_url,source_url`),
      rest(`/used_action_tokens?token_hash=eq.${encodeURIComponent(tokenHash)}&select=used_at`),
    ]);
    const [posting] = await postingRes.json();
    if (!posting) return json({ error: "not_found" }, 404);
    const used = (await usedRes.json()).length > 0;
    return json({
      action: parsed.action,
      used,
      title: posting.title,
      company: posting.company_name,
      city: posting.city,
      triage_status: posting.triage_status,
      skip_reason: posting.skip_reason,
      url: posting.apply_url ?? posting.source_url,
    });
  }

  if (body.op === "confirm") {
    const reason = parsed.action === "skip" ? (body.reason ?? "other") : null;
    if (reason && !SKIP_REASONS.has(reason)) return json({ error: "bad_reason" }, 400);

    const claim = await rest("/used_action_tokens", {
      method: "POST",
      body: JSON.stringify({ token_hash: tokenHash, posting_id: parsed.postingId, action: parsed.action }),
    });
    if (claim.status === 409) return json({ error: "used" }, 409);
    if (!claim.ok) return json({ error: "server" }, 500);

    const res = await rest("/rpc/triage_posting", {
      method: "POST",
      body: JSON.stringify({ p_posting_id: parsed.postingId, p_action: parsed.action, p_reason: reason }),
    });
    if (!res.ok) {
      // Release the token so the owner can retry after a transient failure.
      await rest(`/used_action_tokens?token_hash=eq.${encodeURIComponent(tokenHash)}`, { method: "DELETE" });
      const err = await res.json().catch(() => ({}));
      const code = err?.message === "already applied" ? "already_applied" : "server";
      return json({ error: code }, code === "already_applied" ? 409 : 500);
    }
    return json({ ok: true, ...(await res.json()) });
  }

  return json({ error: "bad_request" }, 400);
});
