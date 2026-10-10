/**
 * jobsignal Gmail bridge (spec 10.1). Runs inside the job-search Google account.
 *
 * Every 15 minutes: send new incoming messages to the ingest-email Edge Function, then carry out
 * the actions it returns (alert email, calendar entry). The function is idempotent on the Gmail
 * message id, so re-sending a message is harmless; the bridge only moves its "last processed"
 * marker past messages that were accepted.
 *
 * Setup: Project Settings → Script Properties → INGEST_URL, INGEST_SECRET; then run setup() once.
 */

const LOOKBACK_FIRST_RUN_DAYS = 3;   // how far back the very first run looks
const OVERLAP_MS = 60 * 60 * 1000;   // re-check the last hour each run (server dedupes)
const MAX_THREADS = 50;
const MAX_BODY = 20000;

function processInbox() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('INGEST_URL');
  const secret = props.getProperty('INGEST_SECRET');
  if (!url || !secret) throw new Error('Set INGEST_URL and INGEST_SECRET in Script Properties first.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;            // a previous run is still going
  try {
    const me = Session.getEffectiveUser().getEmail().toLowerCase();
    const last = Number(props.getProperty('LAST_MS') || (Date.now() - LOOKBACK_FIRST_RUN_DAYS * 86400000));
    const since = last - OVERLAP_MS;
    // Own mail (digests, alerts) excluded; spam and trash are excluded by Gmail search by default.
    const threads = GmailApp.search('-from:me after:' + Math.floor(since / 1000), 0, MAX_THREADS);

    let newestOk = last;
    let oldestFailed = Infinity;
    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        const ts = msg.getDate().getTime();
        if (ts < since || msg.getFrom().toLowerCase().indexOf(me) !== -1) return;
        const res = UrlFetchApp.fetch(url, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-ingest-secret': secret },
          muteHttpExceptions: true,
          payload: JSON.stringify({
            gmail_message_id: msg.getId(),
            gmail_thread_id: thread.getId(),
            from: msg.getFrom(),
            to: msg.getTo(),
            subject: msg.getSubject(),
            date: msg.getDate().toISOString(),
            body_text: (msg.getPlainBody() || '').slice(0, MAX_BODY),
          }),
        });
        if (res.getResponseCode() >= 300) {
          oldestFailed = Math.min(oldestFailed, ts);
          console.warn('ingest failed (' + res.getResponseCode() + ') for a message; will retry next run');
          return;
        }
        newestOk = Math.max(newestOk, ts);
        const body = JSON.parse(res.getContentText() || '{}');
        (body.actions || []).forEach(function (a) { act(a, me); });
      });
    });

    // Never move past a failed message, so it's retried next run.
    const marker = oldestFailed === Infinity ? newestOk : Math.min(newestOk, oldestFailed - 1);
    props.setProperty('LAST_MS', String(Math.max(marker, last)));
  } finally {
    lock.releaseLock();
  }
}

/** Carry out an action returned by ingest-email. */
function act(a, me) {
  if (a.type === 'alert') {
    MailApp.sendEmail(me, a.subject, a.body);
  } else if (a.type === 'event') {
    // 'YYYY-MM-DDTHH:MM' in the script's time zone (Europe/Berlin, see appsscript.json)
    const p = a.start.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if (!p) return;
    const start = new Date(+p[1], +p[2] - 1, +p[3], +p[4], +p[5]);
    const end = new Date(start.getTime() + (a.minutes || 60) * 60000);
    CalendarApp.getDefaultCalendar().createEvent(a.title, start, end, { description: 'Created by jobsignal' });
  } else if (a.type === 'reminder') {
    CalendarApp.getDefaultCalendar().createAllDayEvent(a.title, new Date(), { description: 'Created by jobsignal' });
  }
}

/** Run once after setting the Script Properties: installs the 15-minute trigger and does a first pass. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(15).create();
  processInbox();
}
