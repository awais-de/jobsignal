# Gmail bridge (Google Apps Script)

Runs inside the job-search Google account. Every 15 minutes it sends new incoming messages to the
`ingest-email` Edge Function and carries out what it returns: an alert email for interview
invitations, assessments, information requests and offers, and a calendar entry for interviews.

## Install

1. Signed in to the job-search Google account, open [script.google.com](https://script.google.com) → **New project**, name it `jobsignal bridge`.
2. Replace the contents of `Code.gs` with [`Code.gs`](Code.gs).
3. **Project Settings** (gear icon):
   - tick **Show "appsscript.json" manifest file in editor**, then paste [`appsscript.json`](appsscript.json) into it (sets the time zone);
   - under **Script Properties**, add `INGEST_URL` = `https://<project-ref>.supabase.co/functions/v1/ingest-email`
     and `INGEST_SECRET` = the shared secret (also stored as the Supabase secret `INGEST_SECRET`).
4. Back in the editor, select the `setup` function and click **Run**. Approve the permissions
   (read Gmail, send email to yourself, calendar, call external URLs).
5. Check **Executions** for a successful run.

The first run looks back 3 days. Emails are classified by rules only; nothing is sent to an LLM.
