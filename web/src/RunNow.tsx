import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";

// "Run now": starts the daily pipeline on GitHub via the owner-only trigger-run function.
// Manual runs always run (the once-a-day check only applies to scheduled runs).

type Run = { started_at: string; status: "running" | "success" | "failed" };

const ERRORS: Record<string, string> = {
  not_configured: "Not set up yet: the GitHub token is missing in Supabase.",
  github_error: "GitHub refused the request. Check the token's permissions.",
};

export default function RunNow() {
  const [last, setLast] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);

  const refresh = useCallback(async () => {
    const { data } = await supabase.from("pipeline_runs").select("started_at,status").eq("dry_run", false)
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    setLast(data as Run | null);
    return data as Run | null;
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // After a trigger, poll until a new run has finished (GitHub takes ~30 s to start it).
  useEffect(() => {
    if (!watching) return;
    const started = Date.now();
    const t = setInterval(async () => {
      const r = await refresh();
      const fresh = r && new Date(r.started_at).getTime() > started - 60000;
      if ((fresh && r.status !== "running") || Date.now() - started > 20 * 60000) {
        setWatching(false);
        setMsg(fresh ? (r.status === "success" ? "Done: the digest is in your inbox." : "The run failed: check your email.") : null);
      }
    }, 15000);
    return () => clearInterval(t);
  }, [watching, refresh]);

  async function trigger() {
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.functions.invoke("trigger-run", { body: {} });
    setBusy(false);
    let code = data?.error as string | undefined;
    if (error) {
      try { code = (await (error as { context?: Response }).context?.json())?.error; } catch { code = "network"; }
    }
    if (code) return setMsg(ERRORS[code] ?? "Couldn't start the run.");
    setMsg("Started. New jobs are emailed when it finishes (a few minutes).");
    setWatching(true);
  }

  const running = watching || last?.status === "running";
  return (
    <div className="run-now">
      {last && (
        <span className="muted" title={new Date(last.started_at).toLocaleString("en-GB")}>
          Last run {when(last.started_at)}{" "}
          {last.status === "success" ? "✓" : last.status === "failed" ? "✗" : "…"}
        </span>
      )}
      <button className="small" disabled={busy || running} onClick={trigger}>
        {running ? "Running…" : "Run now"}
      </button>
      {msg && <span className="run-msg">{msg}</span>}
    </div>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return today ? `today ${time}` : `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${time}`;
}
