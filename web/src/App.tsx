import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import ActionPage from "./ActionPage";
import Feed from "./Feed";
import Login from "./Login";

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
  return session ? <Feed /> : <Login />;
}
