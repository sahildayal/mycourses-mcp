#!/usr/bin/env node
// Ad-hoc diagnostics against the live API. Not part of the tool surface.
import { D2LClient } from '../dist/api/client.js';
import { SessionAuthProvider } from '../dist/auth/session.js';
import { HOST } from '../dist/config.js';

const client = new D2LClient(new SessionAuthProvider(HOST), HOST);

const enrollments = await client.getAllPages(
  await client.lp('/enrollments/myenrollments/'),
  { query: { orgUnitTypeId: 3 } },
);

console.log(`total enrollments: ${enrollments.length}\n`);
console.log('most recently accessed 12:');
const sorted = [...enrollments].sort((a, b) =>
  (b.Access?.LastAccessed ?? '').localeCompare(a.Access?.LastAccessed ?? ''),
);
for (const e of sorted.slice(0, 12)) {
  console.log(
    [
      String(e.OrgUnit.Id).padEnd(9),
      (e.OrgUnit.Name ?? '').slice(0, 42).padEnd(44),
      `start=${(e.Access?.StartDate ?? 'null').slice(0, 10)}`,
      `end=${(e.Access?.EndDate ?? 'null').slice(0, 10)}`,
      `active=${e.Access?.IsActive}`,
      `last=${(e.Access?.LastAccessed ?? 'never').slice(0, 10)}`,
    ].join('  '),
  );
}

const now = Date.now();
const notEnded = enrollments.filter(
  (e) => !e.Access?.EndDate || new Date(e.Access.EndDate).getTime() > now,
);
const started = notEnded.filter(
  (e) => !e.Access?.StartDate || new Date(e.Access.StartDate).getTime() <= now,
);
console.log(`\nend date in the future (or none): ${notEnded.length}`);
console.log(`  ...and already started:          ${started.length}`);
for (const e of started) {
  console.log(
    `  ${String(e.OrgUnit.Id).padEnd(9)} ${e.OrgUnit.Name}  end=${(e.Access?.EndDate ?? 'null').slice(0, 10)}`,
  );
}

// Does the calendar route work at all, on a small course set?
const ids = sorted.slice(0, 5).map((e) => e.OrgUnit.Id);
console.log(`\ncalendar probe on ${ids.length} recent courses: ${ids.join(',')}`);
for (const window of [30, 180, 365]) {
  try {
    const events = await client.getAllPages(
      await client.le('/calendar/events/myEvents/'),
      {
        query: {
          orgUnitIdsCSV: ids.join(','),
          startDateTime: new Date(now - window * 86400000).toISOString(),
          endDateTime: new Date(now + window * 86400000).toISOString(),
        },
      },
    );
    console.log(`  +/-${window}d -> ${events.length} event(s)`);
    for (const ev of events.slice(0, 3)) {
      console.log(`      ${ev.StartDateTime ?? ev.EndDateTime} ${ev.Title}`);
    }
  } catch (error) {
    console.log(`  +/-${window}d -> ERROR ${error.message}`);
  }
}

// Find a course that actually has assignments, for the write dry run.
console.log('\nsearching recent courses for assignments...');
for (const e of sorted.slice(0, 10)) {
  try {
    const folders = await client.get(
      await client.le(`/${e.OrgUnit.Id}/dropbox/folders/`),
    );
    if (folders.length) {
      console.log(`  ${e.OrgUnit.Id} ${e.OrgUnit.Name}: ${folders.length} folder(s)`);
      for (const f of folders.slice(0, 3)) {
        console.log(
          `      #${f.Id} "${f.Name}" type=${f.SubmissionType} due=${f.DueDate ?? 'none'} hidden=${f.IsHidden}`,
        );
      }
    }
  } catch (error) {
    console.log(`  ${e.OrgUnit.Id}: ${error.message.slice(0, 80)}`);
  }
}
