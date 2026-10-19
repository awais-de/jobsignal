import { assertEquals, assert } from "jsr:@std/assert@1";
import { classify } from "./classify.ts";
import { cleanStepstoneLinks, jobUrlFromTarget, UNRESOLVED_JOB_LINK, type Fetcher } from "./stepstone.ts";

const JOB = "https://click.stepstone.de/f/a/AAAA~~/BBBB~~/job1";
const CV = "https://click.stepstone.de/f/a/CCCC~~/DDDD~~/upload";
const DOWN = "https://click.stepstone.de/f/a/EEEE~~/FFFF~~/down";
const TARGET = "https://www.stepstone.de/v2/magiclink/exchange?magicLink=SECRET-TOKEN&returnUrl=%2Fstellenangebote----14501566-inline.html%3FCID%3Dx&offer_position=2";

const fake: Fetcher = async (url) => {
  if (url === JOB) return { status: 302, location: TARGET };
  if (url === CV) return { status: 302, location: "https://www.stepstone.de/v2/magiclink/exchange?magicLink=SECRET-TOKEN&returnUrl=%2Fcandidate%2Fcv" };
  throw new Error("timeout");
};

Deno.test("a job link becomes its plain address; other links go; nothing of the login token stays", async () => {
  const text = `Data Engineer (m/w/d)\n${JOB}\nBeispiel AG\nBerlin\n\nLebenslauf hochladen\n${CV}\n\nLetzter Job\n${DOWN}\n`;
  const out = await cleanStepstoneLinks(text, fake);
  assert(out.includes("Data Engineer (m/w/d)\nhttps://www.stepstone.de/stellenangebote----14501566-inline.html\nBeispiel AG"));
  assert(out.includes(`Letzter Job\n${UNRESOLVED_JOB_LINK}`));
  assert(!out.includes("click.stepstone") && !out.includes("SECRET") && !out.includes("magiclink"));
  assert(!out.includes("/candidate/cv"));
});

Deno.test("job address from a redirect target", () => {
  assertEquals(jobUrlFromTarget(TARGET), "https://www.stepstone.de/stellenangebote----14501566-inline.html");
  assertEquals(jobUrlFromTarget("https://www.stepstone.de/stellenangebote--Data-Engineer-Berlin-Beispiel--12345678-inline.html?x=1"),
               "https://www.stepstone.de/stellenangebote--Data-Engineer-Berlin-Beispiel--12345678-inline.html");
  assertEquals(jobUrlFromTarget("https://www.stepstone.de/candidate/settings"), null);
  assertEquals(jobUrlFromTarget(null), null);
});

Deno.test("everything from StepStone's job agent is a job alert", () => {
  assertEquals(classify("jobagent.stepstone.de", "Du passt perfekt: Data Engineer (m/w/d)", "Hallo").category, "job_alert");
  assertEquals(classify("jobagent.stepstone.de", "Wenig Bewerber bisher - deine Chance, um herauszustechen", "").category, "job_alert");
  assertEquals(classify("email.stepstone.de", "Willkommen bei Stepstone", "Hallo").category, "other");
});
