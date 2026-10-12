import { activeTerms, activeTitles, type Family } from "./families";
import { supabase } from "./supabase";

// Saving the owner profile, shared by the Profile page and the Title lab.

export type StoredProfile = {
  search_terms: string[];
  titles: { allow: string[]; block: string[] };
  families?: Family[];
  skills?: Record<string, Record<string, string[]>>;
  [key: string]: unknown;
};

export async function loadProfile(): Promise<{ profile: StoredProfile; version: number } | null> {
  const { data, error } = await supabase.from("owner_profile").select("profile,version").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { profile: data.profile as StoredProfile, version: data.version } : null;
}

/** With families, the flat lists are their union (the pipeline does the same; kept for the YAML fallback).
 *  After saving, stored jobs are re-ranked and re-checked against the families (GitHub workflow, ~1 min). */
export async function saveProfile<P extends StoredProfile>(profile: P): Promise<{ profile: P; version: number; note: string }> {
  const toSave = profile.families?.length
    ? { ...profile, search_terms: activeTerms(profile.families), titles: { ...profile.titles, allow: activeTitles(profile.families) } }
    : profile;
  const { data, error } = await supabase.from("owner_profile").update({ profile: toSave }).eq("id", 1).select("version").single();
  if (error) throw new Error(error.message);
  const { error: rerankError } = await supabase.functions.invoke("trigger-run", { body: { workflow: "rerank" } });
  return {
    profile: toSave, version: data.version,
    note: rerankError ? "Saved. Re-ranking will happen with the next run."
                      : "Saved. Existing jobs are being re-ranked and re-checked: reload the feed in about a minute.",
  };
}
