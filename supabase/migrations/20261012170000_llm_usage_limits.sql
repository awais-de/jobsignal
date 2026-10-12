-- Usage meter (owner request 2026-10-12): what the provider reports about its limits with each call
-- (Groq: x-ratelimit-* headers; on a 429, the limit named in the error, e.g. tokens per day), and
-- prompt tokens served from the provider's cache.
alter table llm_usage add column cached_tokens int;
alter table llm_usage add column limits jsonb;
