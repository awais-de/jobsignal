-- Interview details on events, resume text, and editable JD snapshots (owner requests 2026-10-11).

-- An 'interview_scheduled' (or 'interview_invited') event can carry when and what kind.
-- Events stay append-only: a changed date is a new event.
alter table application_events
  add column scheduled_for  timestamptz,
  add column interview_kind text check (interview_kind in
    ('phone_screen','hr','technical','case_study','onsite','final','other'));

-- Resume text: pasted once by the owner for now; Phase 8 extracts it from the PDF.
-- Text is derived from the (immutable) file, so filling it in doesn't break immutability.
grant update (extracted_text) on resumes to authenticated;

-- applications.jd_snapshot is already updatable by the owner (pasting a missing JD).
