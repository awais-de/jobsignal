import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import ActionPage from "./ActionPage";
import Applications from "./Applications";
import Feed from "./Feed";
import JobPage from "./JobPage";
import Login from "./Login";
import ManualAdd from "./ManualAdd";
import ProfilePage from "./Profile";
import RunNow from "./RunNow";

export default function App() {
  // /a?t=... is the confirm page for email action links; it needs no login (the token is the auth).
  if (window.location.pathname === "/a") return <ActionPage />;
  return <Authed />;
}

function Authed() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return null;
  return session ? <Shell /> : <Login />;
}

type View = "feed" | "applications" | "add" | "profile";
type Route = { view: View; job: string | null };
const JOB_HASH = /^#job\/([0-9a-f-]{36})$/;
function routeFromHash(): Route {
  const m = window.location.hash.match(JOB_HASH);
  if (m) return { view: "feed", job: m[1] };
  const view = ({ "#applications": "applications", "#add": "add", "#profile": "profile" } as Record<string, View>)[window.location.hash] ?? "feed";
  return { view, job: null };
}

// Jobs opened as tabs (like records in a ServiceNow workspace). Open tabs stay mounted, so unsaved
// notes survive switching tabs; the list is remembered per browser.
type JobTab = { id: string; label: string };
const TABS_KEY = "jobsignal.jobtabs";
const MAX_TABS = 10;
function loadTabs(): JobTab[] {
  try {
    const t = JSON.parse(localStorage.getItem(TABS_KEY) ?? "[]");
    return Array.isArray(t) ? t.filter((x) => typeof x?.id === "string" && JOB_HASH.test(`#job/${x.id}`)) : [];
  } catch {
    return [];
  }
}

function Shell() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [view, setView] = useState<View>(route.view);       // the last list view, shown when no job tab is active
  const [tabs, setTabs] = useState<JobTab[]>(loadTabs);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const onHash = () => {
      const r = routeFromHash();
      setRoute(r);
      if (!r.job) setView(r.view);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Opening a job adds its tab (oldest saved tab drops off past the limit).
  useEffect(() => {
    const id = route.job;
    if (!id) return;
    setTabs((ts) => {
      if (ts.some((t) => t.id === id)) return ts;
      let next = [...ts, { id, label: "Loading…" }];
      while (next.length > MAX_TABS) {
        const drop = next.find((t) => t.id !== id && !dirty[t.id]);
        if (!drop) break;
        next = next.filter((t) => t !== drop);
      }
      return next;
    });
  }, [route.job, dirty]);

  useEffect(() => {
    try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch { /* per-browser convenience only */ }
  }, [tabs]);

  const listHash = useRef("#");
  useEffect(() => { listHash.current = view === "feed" ? "#" : `#${view}`; }, [view]);

  const labelSetters = useRef(new Map<string, (l: string) => void>());
  const dirtySetters = useRef(new Map<string, (d: boolean) => void>());
  const setLabel = useCallback((id: string) => {
    if (!labelSetters.current.has(id)) {
      labelSetters.current.set(id, (label: string) =>
        setTabs((ts) => ts.map((t) => (t.id === id && t.label !== label ? { ...t, label } : t))));
    }
    return labelSetters.current.get(id)!;
  }, []);
  const setDirtyFor = useCallback((id: string) => {
    if (!dirtySetters.current.has(id)) {
      dirtySetters.current.set(id, (d: boolean) => setDirty((m) => (!!m[id] === d ? m : { ...m, [id]: d })));
    }
    return dirtySetters.current.get(id)!;
  }, []);

  function closeTab(id: string) {
    if (dirty[id] && !window.confirm("This job has unsaved notes. Close it anyway?")) return;
    setTabs((ts) => ts.filter((t) => t.id !== id));
    setDirty((m) => { const { [id]: _, ...rest } = m; return rest; });
    if (route.job === id) window.location.hash = listHash.current;
  }

  const activeJob = route.job;
  return (
    <div className="wrap">
      <header>
        <nav className="nav">
          <span className="brand">jobsignal</span>
          <a href="#" className={!activeJob && view === "feed" ? "active" : ""}>Feed</a>
          <a href="#applications" className={!activeJob && view === "applications" ? "active" : ""}>Applications</a>
          <a href="#add" className={!activeJob && view === "add" ? "active" : ""}>+ Add</a>
          <a href="#profile" className={!activeJob && view === "profile" ? "active" : ""}>Profile</a>
        </nav>
        <div className="header-right">
          <RunNow />
          <button className="link" onClick={() => supabase.auth.signOut()}>Log out</button>
        </div>
      </header>
      {tabs.length > 0 && (
        <div className="job-tabs" role="tablist">
          {tabs.map((t) => (
            <div key={t.id} className={`job-tab${activeJob === t.id ? " active" : ""}`} role="tab" aria-selected={activeJob === t.id}>
              <a href={`#job/${t.id}`} title={t.label}>{dirty[t.id] && <span className="dot" aria-label="unsaved">● </span>}{t.label}</a>
              <button className="link" aria-label="Close tab" onClick={() => closeTab(t.id)}>×</button>
            </div>
          ))}
        </div>
      )}
      {tabs.map((t) => (
        <div key={t.id} hidden={activeJob !== t.id}>
          <JobPage id={t.id} active={activeJob === t.id} onLabel={setLabel(t.id)} onDirty={setDirtyFor(t.id)} />
        </div>
      ))}
      {/* The list view stays mounted behind a job tab, so going back keeps its filters and open rows. */}
      <div hidden={!!activeJob}>
        {view === "feed" ? <Feed /> : view === "applications" ? <Applications /> : view === "add" ? <ManualAdd /> : <ProfilePage />}
      </div>
    </div>
  );
}
