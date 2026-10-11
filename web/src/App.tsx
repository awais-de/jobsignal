import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import ActionPage from "./ActionPage";
import Applications from "./Applications";
import Feed from "./Feed";
import Login from "./Login";
import ManualAdd from "./ManualAdd";
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

type View = "feed" | "applications" | "add";
const viewFromHash = (): View =>
  window.location.hash === "#applications" ? "applications" : window.location.hash === "#add" ? "add" : "feed";

function Shell() {
  const [view, setView] = useState<View>(viewFromHash);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="wrap">
      <header>
        <nav className="nav">
          <span className="brand">jobsignal</span>
          <a href="#" className={view === "feed" ? "active" : ""}>Feed</a>
          <a href="#applications" className={view === "applications" ? "active" : ""}>Applications</a>
          <a href="#add" className={view === "add" ? "active" : ""}>+ Add</a>
        </nav>
        <div className="header-right">
          <RunNow />
          <button className="link" onClick={() => supabase.auth.signOut()}>Log out</button>
        </div>
      </header>
      {view === "feed" ? <Feed /> : view === "applications" ? <Applications /> : <ManualAdd />}
    </div>
  );
}
