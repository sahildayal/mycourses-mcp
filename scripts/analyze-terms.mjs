#!/usr/bin/env node
// Looks at the shape of the enrolment list so the default course scope can be
// tuned: which courses have no end date, how stale they are, and what each
// candidate filter would actually show today.
import { D2LClient } from '../dist/api/client.js';
import { SessionAuthProvider } from '../dist/auth/session.js';
import { HOST } from '../dist/config.js';

const client = new D2LClient(new SessionAuthProvider(HOST), HOST);
const all = await client.getAllPages(
  await client.lp('/enrollments/myenrollments/'),
  { query: { orgUnitTypeId: 3 } },
);

const now = Date.now();
const days = (iso) => (iso ? Math.round((now - new Date(iso).getTime()) / 86400000) : null);

console.log(`today: ${new Date(now).toISOString().slice(0, 10)}`);
console.log(`total enrolments: ${all.length}\n`);

console.log('=== courses with NO end date (these never expire out of a filter) ===');
for (const e of all.filter((x) => !x.Access?.EndDate)) {
  console.log(
    [
      String(e.OrgUnit.Id).padEnd(9),
      (e.OrgUnit.Name ?? '').slice(0, 46).padEnd(48),
      `start=${(e.Access?.StartDate ?? 'null').slice(0, 10).padEnd(10)}`,
      `lastAccessed=${(e.Access?.LastAccessed ?? 'never').slice(0, 10).padEnd(10)}`,
      `(${days(e.Access?.LastAccessed) ?? '?'}d ago)`,
      `role=${e.Access?.ClasslistRoleName}`,
    ].join('  '),
  );
}

console.log('\n=== courses ending in the future or within 30 days ===');
for (const e of all
  .filter((x) => {
    const end = x.Access?.EndDate;
    return end && new Date(end).getTime() > now - 30 * 86400000;
  })
  .sort((a, b) => (a.Access.EndDate ?? '').localeCompare(b.Access.EndDate ?? ''))) {
  console.log(
    [
      String(e.OrgUnit.Id).padEnd(9),
      (e.OrgUnit.Name ?? '').slice(0, 46).padEnd(48),
      `start=${(e.Access?.StartDate ?? 'null').slice(0, 10)}`,
      `end=${(e.Access?.EndDate ?? 'null').slice(0, 10)}`,
      `role=${e.Access?.ClasslistRoleName}`,
    ].join('  '),
  );
}

console.log('\n=== do any courses START in the future? (what Fall will look like) ===');
const future = all.filter(
  (x) => x.Access?.StartDate && new Date(x.Access.StartDate).getTime() > now,
);
console.log(future.length ? '' : '  none today — Fall 2026 has not appeared yet.');
for (const e of future) {
  console.log(`  ${e.OrgUnit.Id}  ${e.OrgUnit.Name}  start=${e.Access.StartDate?.slice(0, 10)}`);
}

console.log('\n=== roles present across all enrolments ===');
const roles = {};
for (const e of all) {
  const r = e.Access?.ClasslistRoleName ?? 'unknown';
  roles[r] = (roles[r] ?? 0) + 1;
}
console.log(roles);

console.log('\n=== what each candidate default would show TODAY ===');
const strategies = {
  'end date in future only': (e) =>
    !e.Access?.EndDate || new Date(e.Access.EndDate).getTime() > now,
  'end future + no-end-date used in last 180d': (e) => {
    const end = e.Access?.EndDate;
    if (end) return new Date(end).getTime() > now;
    const la = e.Access?.LastAccessed;
    return Boolean(la) && days(la) <= 180;
  },
  'end within last 120d or future (current "recent")': (e) => {
    const end = e.Access?.EndDate;
    if (!end) return true;
    return new Date(end).getTime() > now - 120 * 86400000;
  },
};
for (const [label, fn] of Object.entries(strategies)) {
  const hits = all.filter(fn);
  console.log(`\n  ${label}: ${hits.length}`);
  for (const e of hits) console.log(`      ${e.OrgUnit.Name}`);
}
