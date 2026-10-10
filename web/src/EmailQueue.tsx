import { useEffect, useState } from "react";
import { supabase } from "./supabase";

// Unmatched emails (spec 9.5): one-click assignment to an application, or ignore.

type QueuedEmail = {
  id: string;
  gmail_message_id: string;
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  category: string | null;
  received_at: string | null;
};

const CATEGORY: Record<string, string> = {
  application_confirmation: "Confirmation", rejection: "Rejection", interview_invitation: "Interview",
  assessment: "Assessment", info_request: "Info request", offer: "Offer", other: "Other",
};

export const gmailLink = (id: string) => `https://mail.google.com/mail/u/0/#all/${id}`;

export default function EmailQueue({ apps, onAssigned }: {
  apps: { id: string; label: string }[];
  onAssigned: () => void;
}) {
  const [emails, setEmails] = useState<QueuedEmail[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase.from("inbound_emails")
      .select("id,gmail_message_id,subject,from_name,from_address,category,received_at")
      .eq("match_status", "unmatched").order("received_at", { ascending: false });
    if (error) setError(error.message);
    else setEmails(data as QueuedEmail[]);
  }
  useEffect(() => { load(); }, []);

  async function assign(emailId: string, applicationId: string | null) {
    const { error } = await supabase.rpc("assign_inbound_email",
      { p_email_id: emailId, p_application_id: applicationId });
    if (error) return setError(error.message);
    setEmails((es) => es.filter((e) => e.id !== emailId));
    if (applicationId) onAssigned();
  }

  if (!emails.length) return null;
  return (
    <div className="queue">
      <h3>Emails to assign <span className="day-count">{emails.length}</span></h3>
      {error && <p className="notice">{error}</p>}
      {emails.map((e) => (
        <div key={e.id} className="queue-row">
          <span className={`status status-${e.category === "rejection" ? "red" : e.category === "other" ? "grey" : "orange"}`}>
            {CATEGORY[e.category ?? "other"] ?? e.category}
          </span>
          <div className="queue-text">
            <a href={gmailLink(e.gmail_message_id)} target="_blank" rel="noreferrer">{e.subject || "(no subject)"}</a>
            <div className="muted">
              {e.from_name || e.from_address}
              {e.received_at && ` · ${new Date(e.received_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}`}
            </div>
          </div>
          <select value="" aria-label="Assign to application" onChange={(ev) => ev.target.value && assign(e.id, ev.target.value)}>
            <option value="">Assign to…</option>
            {apps.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          <button className="link" onClick={() => assign(e.id, null)}>Ignore</button>
        </div>
      ))}
    </div>
  );
}
