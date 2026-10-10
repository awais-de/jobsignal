import { useState } from "react";
import { supabase } from "./supabase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      // Sign-ups are disabled; this only logs in an existing user.
      options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
    });
    setState(error ? "error" : "sent");
  }

  return (
    <div className="center">
      <h1>jobsignal</h1>
      {state === "sent" ? (
        <p>Check your inbox for the login link.</p>
      ) : (
        <form onSubmit={send}>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" required autoComplete="email" value={email}
                 onChange={(e) => setEmail(e.target.value)} />
          <button className="primary" disabled={state === "sending"}>Send login link</button>
          {state === "error" && <p className="notice">Couldn't send the link. Try again in a minute.</p>}
        </form>
      )}
    </div>
  );
}
