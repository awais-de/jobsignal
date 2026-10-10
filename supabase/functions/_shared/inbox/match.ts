// Matching an email to an open application (spec 10.5), in order:
// 1. same Gmail thread as an earlier matched email
// 2. reference number equals the posting's reference_number
// 3. same company and title similarity >= TITLE_THRESHOLD
// 4. same company and exactly one open application there
import { sameCompany, titleSimilarity } from "./normalize.ts";

export const TITLE_THRESHOLD = 0.8; // STARTING VALUE

export type OpenApp = { id: string; company: string; title: string; reference_number: string | null };
export type EmailFacts = { company: string | null; role_title: string | null; reference_number: string | null };
export type Match = { application_id: string; method: "thread" | "reference" | "company_title" | "company_only" };

export function matchApplication(email: EmailFacts, open: OpenApp[], threadAppId: string | null): Match | null {
  if (threadAppId && open.some((a) => a.id === threadAppId)) return { application_id: threadAppId, method: "thread" };

  const ref = email.reference_number?.toLowerCase();
  if (ref) {
    const hit = open.filter((a) => a.reference_number?.toLowerCase() === ref);
    if (hit.length === 1) return { application_id: hit[0].id, method: "reference" };
  }
  if (!email.company) return null;
  const atCompany = open.filter((a) => sameCompany(a.company, email.company!));
  if (email.role_title) {
    const scored = atCompany
      .map((a) => ({ a, s: titleSimilarity(a.title, email.role_title!) }))
      .filter((x) => x.s >= TITLE_THRESHOLD)
      .sort((x, y) => y.s - x.s);
    if (scored.length === 1 || (scored.length > 1 && scored[0].s > scored[1].s)) {
      return { application_id: scored[0].a.id, method: "company_title" };
    }
  }
  if (atCompany.length === 1) return { application_id: atCompany[0].id, method: "company_only" };
  return null;
}
