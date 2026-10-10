import { useEffect, useState } from "react";
import { ACTION_URL, SKIP_REASONS } from "./supabase";

// Confirm page for digest links (spec 7.10). Loading it only "peeks"; the
// action happens on a button tap, so link scanners can't trigger anything.

type Peek = {
  action: "apply" | "skip";
  used: boolean;
  title: string;
  company: string;
  city: string | null;
  triage_status: string;
  skip_reason: string | null;
  url: string | null;
};

const ERRORS: Record<string, string> = {
  invalid: "This link isn't valid.",
  expired: "This link has expired. Use the app instead.",
  not_found: "This job no longer exists (it may have been deleted).",
  used: "This link was already used.",
  already_applied: "You already applied to this job, so it can't be skipped.",
};

async function call(body: object) {
  const res = await fetch(ACTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export default function ActionPage() {
  const token = new URLSearchParams(window.location.search).get("t") ?? "";
  const [peek, setPeek] = useState<Peek | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    call({ op: "peek", token })
      .then((r) => (r.error ? setError(r.error) : setPeek(r)))
      .catch(() => setError("network"));
  }, [token]);

  async function confirm(reason?: string) {
    setBusy(true);
    const r = await call({ op: "confirm", token, reason }).catch(() => ({ error: "network" }));
    setBusy(false);
    if (r.error) return setError(r.error);
    if (peek?.action === "apply" && r.url) {
      window.location.href = r.url;
      return;
    }
    setDone(reason ? SKIP_REASONS.find((s) => s.key === reason)?.label ?? reason : "done");
  }

  return (
    <div className="center">
      <h1>jobsignal</h1>
      {error ? (
        <p className="notice">{ERRORS[error] ?? "Something went wrong. Try again."}</p>
      ) : !peek ? (
        <p>Loading…</p>
      ) : (
        <>
          <div className="card">
            <div className="title">{peek.title}</div>
            <div className="meta">{[peek.company, peek.city].filter(Boolean).join(" · ")}</div>
          </div>
          {done ? (
            <p>Skipped ({done}). You can close this tab.</p>
          ) : peek.used ? (
            <p className="notice">
              {ERRORS.used} Current status: {peek.triage_status}
              {peek.skip_reason ? ` (${peek.skip_reason})` : ""}.
            </p>
          ) : peek.action === "apply" ? (
            <>
              <p>Mark this job as <strong>applying</strong> and open the posting?</p>
              <button className="primary" disabled={busy} onClick={() => confirm()}>
                Confirm and open posting
              </button>
            </>
          ) : (
            <>
              <p>Why skip it?</p>
              <div className="reasons">
                {SKIP_REASONS.map((r) => (
                  <button key={r.key} className="chip" disabled={busy} onClick={() => confirm(r.key)}>
                    {r.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
