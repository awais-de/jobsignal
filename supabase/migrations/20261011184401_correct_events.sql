-- Owner can correct an event's date and details (e.g. an import recorded the wrong 'applied' day).
-- The event type stays immutable: a rejection can't be turned into an offer, only re-dated.
-- (Owner decision 2026-10-11; relaxes the strict append-only rule from spec 6.6.)
grant update (occurred_at, scheduled_for, interview_kind, notes) on application_events to authenticated;
