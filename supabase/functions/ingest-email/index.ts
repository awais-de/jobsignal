// ingest-email (spec 10.2): called by the Apps Script bridge for each new message.
// Header x-ingest-secret must equal INGEST_SECRET. Idempotent on gmail_message_id.
// Response: { duplicate?, category, match_status, actions: [...] } where actions tell the bridge
// to send an alert email or create a calendar entry (the bridge runs inside the Google account).

import { classify, type Category } from "../_shared/inbox/classify.ts";
import { extractFields } from "../_shared/inbox/extract.ts";
import { matchApplication, type OpenApp } from "../_shared/inbox/match.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? "";
const APP_URL = Deno.env.get("ALLOWED_ORIGIN") ?? "";

const TERMINAL = new Set(["rejected", "withdrawn", "offer_accepted", "offer_declined"]);
const URGENT: Partial<Record<Category, string>> = {
  interview_invitation: "Interview invitation", assessment: "Assessment", info_request: "Information requested",
  offer: "Offer",
};
const EVENT_FOR: Partial<Record<Category, string>> = {
  application_confirmation: "confirmation_received", rejection: "rejected", interview_invitation: "interview_invited",
  assessment: "assessment_received", info_request: "info_requested", offer: "offer_received",
};

type Action =
  | { type: "alert"; subject: string; body: string }
  | { type: "event"; title: string; start: string; minutes: number }
  | { type: "reminder"; title: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`db ${init.method ?? "GET"} ${path.split("?")[0]} ${res.status}`);
  const text = await res.text();   // inserts without return=representation answer 201 with no body
  return text ? JSON.parse(text) : null;
}

function safeEqual(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function parseFrom(from: string): { name: string; address: string; domain: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const address = (m ? m[2] : from).trim().toLowerCase();
  return { name: m ? m[1].trim() : "", address, domain: address.split("@")[1] ?? "" };
}

async function openApplications(): Promise<OpenApp[]> {
  const apps = await rest("/applications?deleted_at=is.null&select=id,job_postings(title,company_name,reference_number)");
  const statuses = await rest("/application_status?select=application_id,status");
  const status = new Map((statuses as { application_id: string; status: string }[]).map((s) => [s.application_id, s.status]));
  return (apps as any[])
    .filter((a) => !TERMINAL.has(status.get(a.id) ?? ""))
    .map((a) => ({ id: a.id, company: a.job_postings.company_name, title: a.job_postings.title,
                   reference_number: a.job_postings.reference_number }));
}

async function writeEvent(appId: string, type: string, at: string, emailId: string, confidence: number) {
  await rest("/application_events", {
    method: "POST",
    body: JSON.stringify({ application_id: appId, event_type: type, occurred_at: at, source: "email",
                           inbound_email_id: emailId, confidence }),
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!safeEqual(req.headers.get("x-ingest-secret") ?? "", INGEST_SECRET)) return json({ error: "forbidden" }, 403);
  try {
    return await handle(req);
  } catch (err) {
    // Path and status only (see rest()); the bridge retries the message on its next run.
    return json({ error: "processing_failed", detail: String((err as Error).message).slice(0, 200) }, 500);
  }
});

async function handle(req: Request): Promise<Response> {

  let m: Record<string, string>;
  try { m = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  if (!m.gmail_message_id) return json({ error: "bad_request" }, 400);

  const from = parseFrom(m.from ?? "");
  const subject = (m.subject ?? "").slice(0, 500);
  const body = (m.body_text ?? "").slice(0, 20000);
  const receivedAt = m.date ? new Date(m.date).toISOString() : new Date().toISOString();

  // 1. store once (spec 10.2.2)
  const inserted = await rest("/inbound_emails?on_conflict=gmail_message_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({
      gmail_message_id: m.gmail_message_id, gmail_thread_id: m.gmail_thread_id ?? null,
      from_address: from.address, from_name: from.name || null, from_domain: from.domain || null,
      to_address: (m.to ?? "").slice(0, 300), subject, received_at: receivedAt, body_text: body,
    }),
  });
  if (!inserted?.length) return json({ duplicate: true, actions: [] });
  const emailId: string = inserted[0].id;

  // 2. classify + extract (spec 10.3, 10.4)
  const cls = classify(from.domain, subject, body);
  const facts = extractFields(from.name, from.domain, subject, body);
  const actions: Action[] = [];
  let matchStatus = "ignored";
  let applicationId: string | null = null;
  const gmailLink = `https://mail.google.com/mail/u/0/#all/${m.gmail_message_id}`;

  // 3. match and act (spec 10.5)
  if (EVENT_FOR[cls.category]) {
    const open = await openApplications();
    const thread = m.gmail_thread_id
      ? await rest(`/inbound_emails?gmail_thread_id=eq.${encodeURIComponent(m.gmail_thread_id)}` +
                   `&application_id=not.is.null&select=application_id&limit=1`)
      : [];
    const match = matchApplication(facts, open, thread[0]?.application_id ?? null);
    const confident = cls.confidence >= 0.9 || match?.method === "thread";

    if (match && confident) {
      applicationId = match.application_id;
      matchStatus = "matched";
      if (cls.category === "application_confirmation") {
        const applied = await rest(`/application_events?application_id=eq.${applicationId}&event_type=eq.applied&select=id&limit=1`);
        if (!applied.length) await writeEvent(applicationId, "applied", receivedAt, emailId, cls.confidence);
      }
      await writeEvent(applicationId, EVENT_FOR[cls.category]!, receivedAt, emailId, cls.confidence);
    } else if (!match && cls.category === "application_confirmation" && cls.confidence >= 0.9 && facts.company) {
      // A hand application that was never logged: create it (origin email_inferred).
      const [posting] = await rest("/job_postings", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          dedupe_hash: `manual:${crypto.randomUUID()}`, source: "manual", company_name: facts.company,
          title: facts.role_title ?? subject.slice(0, 120), reference_number: facts.reference_number,
          description_missing: true, extraction_status: "skipped", filter_status: "passed",
          triage_status: "applied", triaged_at: receivedAt, first_seen_at: receivedAt,
        }),
      });
      const [app] = await rest("/applications", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ job_posting_id: posting.id, origin: "email_inferred", applied_at: receivedAt }),
      });
      applicationId = app.id;
      matchStatus = "auto_created";
      await writeEvent(app.id, "applied", receivedAt, emailId, cls.confidence);
      await writeEvent(app.id, "confirmation_received", receivedAt, emailId, cls.confidence);
    } else {
      matchStatus = "unmatched";   // the one-click queue (spec 9.5)
    }
  } else if (cls.category === "account_created") {
    const login = (m.to ?? "").match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase();
    if (login) {
      await rest("/portal_accounts?on_conflict=portal_domain,login_email", {
        method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({
          company_name: facts.company ?? from.name ?? from.domain, portal_domain: from.domain,
          ats: facts.ats, login_email: login, origin: "email",
        }),
      });
    }
    matchStatus = "matched";
  }
  // job_alert: parsed into postings in Phase 6; 'other': nothing to do.

  // 4. urgent alerts and calendar (spec 10.5, 10.9). Interviews alert even at low confidence.
  const urgent = URGENT[cls.category] ??
    (cls.candidates.includes("interview_invitation") ? "Possible interview invitation" : undefined);
  if (urgent) {
    const who = [facts.company, facts.role_title].filter(Boolean).join(" – ") || from.name || from.address;
    actions.push({
      type: "alert",
      subject: `[jobsignal] ${urgent}: ${who}`.slice(0, 200),
      body: [
        `${urgent} from ${from.name || from.address}.`,
        `Subject: ${subject}`,
        `Confidence: ${Math.round(cls.confidence * 100)}%` + (matchStatus === "unmatched" ? " (not matched to an application yet)" : ""),
        `Open the email: ${gmailLink}`,
        APP_URL ? `Applications: ${APP_URL}/#applications` : "",
      ].filter(Boolean).join("\n"),
    });
    if (cls.category === "interview_invitation" || urgent.startsWith("Possible")) {
      actions.push(facts.interview_at
        ? { type: "event", title: `Interview: ${who}`, start: facts.interview_at, minutes: 60 }
        : { type: "reminder", title: `Reply to interview invitation: ${who}` });
    }
  }

  await rest(`/inbound_emails?id=eq.${emailId}`, {
    method: "PATCH",
    body: JSON.stringify({
      category: cls.category, classified_by: "rules", confidence: cls.confidence,
      extracted: { ...facts, candidates: cls.candidates }, match_status: matchStatus,
      application_id: applicationId, processed_at: new Date().toISOString(),
    }),
  });
  return json({ category: cls.category, match_status: matchStatus, actions });
}
