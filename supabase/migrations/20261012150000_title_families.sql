-- Title families (owner decision 2026-10-12, pipeline/families.py): which family matched a job's
-- title, and its lane. 'core' = digest + main feed; 'explore' = only the app's Explore tab.
-- Rows from before have no lane and count as core.
alter table job_postings add column title_family text;
alter table job_postings add column lane text check (lane in ('core','explore'));
create index job_postings_lane_idx on job_postings (lane, first_seen_at desc) where filter_status = 'passed';
