-- Outreach replies and what works (owner request 2026-10-13): the reply itself, its outcome, and which
-- message variant got it (before / after applying, language), so reply rates can be compared.
alter table outreach add column reply_text text;
alter table outreach add column reply_outcome text check (reply_outcome in
  ('positive','asked_for_info','interview','referred','neutral','not_interested'));
alter table outreach add column kind text check (kind in ('pre_apply','post_apply','other'));
alter table outreach add column lang text check (lang in ('de','en'));

-- Earlier pings: variant and language from the generated text.
update outreach set kind = case
    when message_text ~* '(bevor ich mich bewerbe|before i apply)' then 'pre_apply'
    when message_text ~* '(habe mich gerade|just applied)' then 'post_apply'
    else 'other' end
  where kind is null and message_text is not null;
update outreach set lang = case when message_text ~* '^(hallo|guten tag)' then 'de' else 'en' end
  where lang is null and message_text is not null;
