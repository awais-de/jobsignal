# jobsignal

Personal job-search system: a daily ranked job feed plus an application tracker that updates itself from email.

- **The spec is `private/spec.md` (revision 2).** Read it before any work. Section 14 lists the build phases, section 15 the decisions already made and those still open. `private/spec-original.md` is revision 1, for reference only.
- **This repo is public.** `private/`, `config/profile.yaml`, secrets and real company or personal data never go into git. Follow spec section 13.1 before every commit, and keep this file free of personal details.
- Build one phase at a time and stop when that phase's acceptance criteria pass. Phase 0 accepted 2026-10-10. Phase 1 (feed) live 2026-10-10, accepted once digests arrive 11–13 Oct. Phase 2 (UI, triage, action links) built 2026-10-10. Phase 4 partly pulled forward (Applications view, events, resumes). **Phase 3 (extraction + ranking)** live 2026-10-11 with Groq free tier; Gemini fallback built but disabled (paid tier only, EEA terms). Open in Phase 3: precision@10 display and the weekly recall-check queue, once a week of labels exists.
- Local setup: `.venv` (`pip install -r requirements-dev.txt`), `brew install gitleaks`, `pre-commit install`. Supabase is linked; apply migrations with `supabase db push`. After editing the gitignored profile, run `gh secret set PROFILE_YAML < pipeline/config/profile.yaml`.
- Stack: Python pipeline on GitHub Actions cron, Supabase (Postgres + Edge Functions), Google Apps Script bridge, React + Vite + TS front end in `web/`, served as static assets by a Cloudflare Worker (`web/wrangler.jsonc`, auto-deployed from `main`).
- Spec markers: `VERIFY` means check against live docs before relying on it, `DECISION NEEDED` means ask the owner, `STARTING VALUE` means it goes in config.
