import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

// The publishable key is public by design: RLS (owner-only) protects the data.
export const supabase = createClient(SUPABASE_URL, KEY);

export const ACTION_URL = `${SUPABASE_URL}/functions/v1/action`;

export const SKIP_REASONS: { key: string; label: string }[] = [
  { key: "too_senior", label: "Too senior" },
  { key: "wrong_stack", label: "Wrong stack" },
  { key: "language", label: "Language" },
  { key: "location", label: "Location" },
  { key: "contract_type", label: "Contract type" },
  { key: "not_interesting", label: "Not interesting" },
  { key: "looks_fake", label: "Looks fake" },
  { key: "other", label: "Other" },
];

// Display names for job_postings.source. Add an entry when a new source is added.
export const SOURCE_LABELS: Record<string, string> = {
  ba_api: "Arbeitsagentur",
  manual: "Added by hand",
  sample: "Sample",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export type Posting = {
  id: string;
  source: string;
  title: string;
  company_name: string;
  city: string | null;
  location_raw: string | null;
  remote_policy: string | null;
  posted_date: string | null;
  salary_text: string | null;
  poster_type: string | null;
  apply_url: string | null;
  source_url: string | null;
  surfaced_on: string | null;
  first_seen_at: string;
  triage_status: "new" | "applied" | "skipped";
  skip_reason: string | null;
  manually_edited: boolean;
  extraction_status: string;
  rank_score: number | null;
  rank_details: { matched?: string[]; missing?: string[]; track?: string | null } | null;
  german_level: string | null;
  required_years: number | null;
  seniority: string | null;
  must_have_skills: string[] | null;
  nice_to_have_skills: string[] | null;
};

export const POSTING_COLUMNS =
  "id,source,title,company_name,city,location_raw,remote_policy,posted_date,salary_text,poster_type," +
  "apply_url,source_url,surfaced_on,first_seen_at,triage_status,skip_reason,manually_edited," +
  "extraction_status,rank_score,rank_details,german_level,required_years,seniority,must_have_skills,nice_to_have_skills";
