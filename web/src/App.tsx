import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import ActionPage from "./ActionPage";
import Applications from "./Applications";
import Feed from "./Feed";
import Home from "./Home";
import MasterCv from "./MasterCv";
import JobPage from "./JobPage";
import Lab from "./Lab";
import People from "./People";
import Responses from "./Responses";
import Skills from "./Skills";
import Login from "./Login";
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

type View = "home" | "feed" | "lab" | "applications" | "responses" | "people" | "skills" | "mastercv" | "profile";
type Route = { view: View; job: string | null };
const JOB_HASH = /^#job\/([0-9a-f-]{36})$/;
// Old links keep working: #add is on Applications, #control on Home.
const HASH_VIEWS: Record<string, View> = {
  "": "home", "#": "home", "#home": "home", "#control": "home", "#feed": "feed", "#lab": "lab",
  "#applications": "applications", "#add": "applications", "#responses": "responses", "#people": "people",
  "#skills": "skills", "#mastercv": "mastercv", "#profile": "profile",
};
function routeFromHash(): Route {
  const m = window.location.hash.match(JOB_HASH);
  if (m) return { view: "feed", job: m[1] };
  return { view: HASH_VIEWS[window.location.hash] ?? "home", job: null };
}

// The menu: sections, each with one or more pages (shown as sub-tabs). Home opens from the brand.
type Section = "feed" | "applications" | "outreach" | "me";
const SECTIONS: { key: Section; label: string; pages: { view: View; label: string }[] }[] = [
  { key: "feed", label: "Feed", pages: [{ view: "feed", label: "Jobs" }, { view: "lab", label: "Lab" }] },
  { key: "applications", label: "Applications", pages: [{ view: "applications", label: "Applications" }] },
  { key: "outreach", label: "Outreach", pages: [{ view: "responses", label: "Responses" }, { view: "people", label: "People" }] },
  { key: "me", label: "Me", pages: [{ view: "skills", label: "Skills" }, { view: "mastercv", label: "Master CV" }, { view: "profile", label: "Profile" }] },
];
const sectionOf = (v: View) => SECTIONS.find((s) => s.pages.some((p) => p.view === v));

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
  // Each section reopens on the page last used in it.
  const [lastPage, setLastPage] = useState<Record<string, View>>({});
  useEffect(() => { const sec = sectionOf(view); if (sec) setLastPage((m) => ({ ...m, [sec.key]: view })); }, [view]);

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
  useEffect(() => { listHash.current = view === "home" ? "#" : `#${view}`; }, [view]);

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
  const section = sectionOf(view);
  return (
    <div className="wrap">
      <header>
        <nav className="nav">
          <a href="#" className={`brand${!activeJob && view === "home" ? " active" : ""}`} title="Home: overview and control panel">jobsignal</a>
          {SECTIONS.map((sec) => (
            <a key={sec.key} href={`#${lastPage[sec.key] ?? sec.pages[0].view}`}
               className={!activeJob && section?.key === sec.key ? "active" : ""}>{sec.label}</a>
          ))}
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
        {section && section.pages.length > 1 && (
          <div className="tabs section-tabs">
            {section.pages.map((p) => (
              <a key={p.view} href={`#${p.view}`} className={`tab-link${view === p.view ? " active" : ""}`}>{p.label}</a>
            ))}
          </div>
        )}
        {view === "home" ? <Home /> : view === "feed" ? <Feed /> : view === "applications" ? <Applications /> : view === "lab" ? <Lab /> : view === "responses" ? <Responses /> : view === "people" ? <People /> : view === "skills" ? <Skills /> : view === "mastercv" ? <MasterCv /> : <ProfilePage />}
      </div>
    </div>
  );
}
