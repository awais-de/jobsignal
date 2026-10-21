// Run: deno test supabase/functions/
import { assertEquals } from "jsr:@std/assert@1.0.13";
import { berlin, EXPECTED_BRIDGE_VERSION, type Status, warnings } from "./warnings.ts";

const NOW = new Date("2026-10-14T09:00:00Z");
function ok(): Status {
  return {
    db: {
      checked_at: NOW.toISOString(), db_bytes: 40e6, storage: [],
      cron: [{ jobname: "jobsignal-daily", status: "succeeded", start_time: "2026-10-14T05:17:00Z", message: null }],
      http: [{ status_code: 200, created: "2026-10-14T05:17:01Z", error: "" }],
      runs: [{ started_at: "2026-10-14T05:17:30Z", finished_at: "2026-10-14T05:35:00Z", status: "success", error: "" }],
      sources: [{ source: "ba_api", failed: 0, runs: 7, last_ok: "2026-10-14T05:20:00Z", last3: ["success", "success", "success"] }],
      inbox: { last_at: "2026-10-14T08:40:00Z", total: 40, unmatched: 0, bridge_version: EXPECTED_BRIDGE_VERSION },
      backlog: { core: 0, explore: 10 },
    },
    github: { configured: true, ok: true, token_expires: "2027-01-01T00:00:00Z", workflows: [], failures_24h: [] },
    drive: { configured: true, ok: true, version: EXPECTED_BRIDGE_VERSION, folder: "Resumes", folder_error: null },
    llm: { rate_limited_days: 0 },
  };
}

Deno.test("a healthy app has no warnings", () => assertEquals(warnings(ok(), NOW), []));

Deno.test("missing daily run, failing source, scheduler, token, bridge, AI, limits", () => {
  const s = ok();
  s.db.runs = [{ started_at: "2026-10-13T05:17:30Z", finished_at: null, status: "failed", error: "SMTP auth" }];
  s.db.sources = [{ source: "careers:Beispiel AG", failed: 3, runs: 3, last_ok: null, last3: ["failed", "failed", "failed"] }];
  s.db.cron = [];
  s.github.token_expires = "2026-10-20T00:00:00Z";
  s.db.inbox = { last_at: "2026-10-12T08:00:00Z", total: 40, unmatched: 2, bridge_version: "2026-10-01" };
  s.llm.rate_limited_days = 3;
  s.db.db_bytes = 480 * 1024 * 1024;
  s.drive = { configured: false };
  const w = warnings(s, NOW);
  const areas = w.map((x) => `${x.level}:${x.area}`);
  for (const a of ["red:Pipeline", "amber:Sources", "amber:Scheduler", "amber:GitHub", "amber:Email bridge", "amber:AI", "red:Supabase", "amber:Drive"]) {
    assertEquals(areas.includes(a), true, `expected ${a} in ${areas.join(", ")}`);
  }
  assertEquals(w[0].level, "red");                       // reds first
  assertEquals(w.some((x) => x.text.includes("Company site: Beispiel AG")), true);
});

Deno.test("before 07:30 German time a missing run is not yet a warning", () => {
  const s = ok();
  s.db.runs = [];
  s.db.cron = [];
  assertEquals(warnings(s, new Date("2026-10-14T05:07:00Z")), []);
});

Deno.test("expired or refused GitHub token is red", () => {
  const s = ok();
  s.github = { configured: true, ok: false, error: "HTTP 401", workflows: [], failures_24h: [] };
  assertEquals(warnings(s, NOW)[0], { level: "red", area: "GitHub", text: "GitHub refused the token (HTTP 401): it may have expired." });
});

Deno.test("a workflow failure already followed by a success is not a warning", () => {
  const s = ok();
  s.github.failures_24h = [{ name: "cv-compile", created_at: "2026-10-13T18:44:00Z", url: "" }];
  s.github.workflows = [{ name: "cv-compile", status: "completed", conclusion: "success", created_at: "2026-10-13T20:47:00Z", url: "" }];
  assertEquals(warnings(s, NOW), []);
  s.github.workflows = [{ name: "cv-compile", status: "completed", conclusion: "failure", created_at: "2026-10-13T18:44:00Z", url: "" }];
  assertEquals(warnings(s, NOW).map((x) => x.area), ["GitHub"]);
});

Deno.test("the Berlin clock across the clock change", () => {
  assertEquals(berlin(new Date("2026-10-21T05:17:00Z")), { day: "2026-10-21", minutes: 7 * 60 + 17 });   // CEST
  assertEquals(berlin(new Date("2026-10-27T06:17:00Z")), { day: "2026-10-27", minutes: 7 * 60 + 17 });   // CET
  assertEquals(berlin(new Date("2026-10-21T22:30:00Z")).day, "2026-10-22");
});

Deno.test("the fast lane is warned about only after 3 failures in a row, and never counts as the daily run", () => {
  const s = ok();
  s.db.fast_runs = [{ started_at: "2026-10-14T08:30:00Z", status: "failed", error: "ReadTimeout" },
                    { started_at: "2026-10-14T08:00:00Z", status: "failed", error: "ReadTimeout" },
                    { started_at: "2026-10-14T07:30:00Z", status: "failed", error: "ReadTimeout" }];
  assertEquals(warnings(s, NOW).map((x) => x.area), ["Fast lane"]);
  s.db.fast_runs[2].status = "success";
  assertEquals(warnings(s, NOW), []);
});
