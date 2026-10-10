# jobsignal

Personal job-search system: a daily ranked job feed plus an application tracker that updates itself from email.

- **The spec is `private/spec.md` (revision 2).** Read it before any work. Section 14 lists the build phases, section 15 the decisions already made and those still open. `private/spec-original.md` is revision 1, for reference only.
- **This repo is public.** `private/`, `config/profile.yaml`, secrets and real company or personal data never go into git. Follow spec section 13.1 before every commit, and keep this file free of personal details.
- Build one phase at a time and stop when that phase's acceptance criteria pass. Current phase: **Phase 0 (project setup)**, not started.
- Stack: Python pipeline on GitHub Actions cron, Supabase (Postgres + Edge Functions), Google Apps Script bridge, React + Vite + TS front end (from Phase 2).
- Spec markers: `VERIFY` means check against live docs before relying on it, `DECISION NEEDED` means ask the owner, `STARTING VALUE` means it goes in config.
