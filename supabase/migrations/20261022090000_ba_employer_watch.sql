-- Arbeitsagentur employer watch (owner request 2026-10-21, step 3 of the fast lane): group-A companies whose
-- career site can't be read are asked for by employer at the Arbeitsagentur (v6 search, arbeitgeber=<name>;
-- verified live 2026-10-21: exact-name filter, 80 of 130 such companies post there). The daily run checks all
-- of them and sets ba_watch; the fast lane asks only those with ba_watch.

alter table companies add column ba_watch boolean not null default false;
alter table companies add column ba_checked_at timestamptz;
create index companies_ba_watch_idx on companies (ba_watch) where ba_watch and deleted_at is null;
