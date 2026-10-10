# jobsignal

Personal job-search system: a daily ranked job feed plus an application tracker that updates itself from email.

- **The spec is `private/spec.md` (revision 2).** Read it before any work. Section 14 lists the build phases, section 15 the decisions already made and those still open. `private/spec-original.md` is revision 1, for reference only.
- **This repo is public.** `private/`, `config/profile.yaml`, secrets and real company or personal data never go into git. Follow spec section 13.1 before every commit, and keep this file free of personal details.
- Build one phase at a time and stop when that phase's acceptance criteria pass. Phases 0–4 built (0 accepted; 1 accepted once digests arrive 11–13 Oct). Phase 3 uses Groq free tier; Gemini fallback disabled (paid tier only, EEA terms). **Phase 5 (inbox automation)** built 2026-10-11, rules only (no LLM reads email); live once the owner installs `apps-script/` in the job-search Google account. Open in Phase 3: precision@10 display and weekly recall check.
- Local setup: `.venv` (`pip install -r requirements-dev.txt`), `brew install gitleaks`, `pre-commit install`. Supabase is linked; apply migrations with `supabase db push`. After editing the gitignored profile, run `gh secret set PROFILE_YAML < pipeline/config/profile.yaml`.
- Email logic: `supabase/functions/_shared/inbox/` (Deno, tested with `deno test supabase/functions/`); the extraction prompt/schema is shared by Python and Deno in `supabase/functions/_shared/jd_extraction.json`.
- Stack: Python pipeline on GitHub Actions cron, Supabase (Postgres + Edge Functions), Google Apps Script bridge, React + Vite + TS front end in `web/`, served as static assets by a Cloudflare Worker (`web/wrangler.jsonc`, auto-deployed from `main`).
- Spec markers: `VERIFY` means check against live docs before relying on it, `DECISION NEEDED` means ask the owner, `STARTING VALUE` means it goes in config.
