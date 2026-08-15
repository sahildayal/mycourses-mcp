#!/usr/bin/env node
// Checks whether a new term's courses have appeared and look healthy, and
// writes a dated report. Intended to be run daily by a Windows Scheduled Task
// across the window when a term is due to appear, but safe to run by hand.
//
// Exit codes, which the scheduled-task wrapper uses to decide whether to
// interrupt: 0 = nothing new, stay quiet. 1 = needs attention.
// 2 = new courses have appeared since the last run.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const today = new Date().toISOString().slice(0, 10);
const reportPath = join(root, 'reports', `fall-check-${today}.md`);
const statePath = join(root, 'reports', 'state.json');

/** Course ids seen on the previous run, so "new" means genuinely new. */
async function readState() {
  try {
    // Strip a BOM — Windows editors and PowerShell add one, and it makes
    // JSON.parse throw, which would silently reset the baseline.
    const raw = (await readFile(statePath, 'utf8')).replace(/^﻿/, '');
    return JSON.parse(raw);
  } catch {
    return { knownCourseIds: [] };
  }
}
const previous = await readState();
let newCourses = [];

const lines = [];
const say = (s = '') => {
  lines.push(s);
  console.log(s);
};

let needsAttention = false;
const flag = (s) => {
  needsAttention = true;
  say(`- [ ] ${s}`);
};

const client = new Client({ name: 'fall-check', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'dist', 'index.js')],
  }),
);

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) return { error: text };
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

say(`# myCourses term check — ${today}`);
say();

// 1. Is the session usable at all? Everything downstream depends on this.
const auth = await call('auth_status');
say('## Session');
say();
if (!auth.authenticated) {
  flag(
    'No usable myCourses session. Run `node dist/cli.js login` in ' +
      `${root}, then re-run this check.`,
  );
  say();
  say('Nothing else could be checked without a session.');
  await finish();
}
say(`Authenticated, session captured ${auth.savedAt} (${auth.ageHours} h ago).`);
say();

// 2. What does the current term look like?
const courses = await call('list_courses');
say('## Current courses');
say();
if (courses.error) {
  flag(`list_courses failed: ${courses.error}`);
} else {
  say(`Scope \`${courses.scope}\` — ${courses.count} of ${courses.totalEnrolments} enrolments.`);
  say();
  say('| id | course | role | status |');
  say('|---|---|---|---|');
  for (const c of courses.courses ?? []) {
    say(
      `| ${c.courseId} | ${c.name} | ${c.role}${c.isAssisting ? ' (assisting)' : ''} | ${c.status} |`,
    );
  }
  say();

  const student = (courses.courses ?? []).filter((c) => !c.isAssisting);
  const live = student.filter(
    (c) => c.status === 'in_session' || c.status === 'upcoming',
  );
  const unopened = student.filter((c) => c.status === 'not_yet_open');

  if (live.length === 0 && unopened.length === 0) {
    say(
      'No student courses are in session or upcoming yet. If classes are about ' +
        'to start, the new term has not been published to myCourses — this check ' +
        'runs again tomorrow.',
    );
  } else {
    say(`${live.length} live/upcoming student course(s), ${unopened.length} not yet published.`);
  }

  // Anything not seen on a previous run is the new term arriving. With no
  // baseline yet, every course would look new — so the first run just records
  // what is there and stays quiet.
  const known = new Set(previous.knownCourseIds ?? []);
  if (known.size > 0) {
    newCourses = (courses.courses ?? []).filter((c) => !known.has(c.courseId));
    if (newCourses.length) {
      say();
      say(`**${newCourses.length} course(s) appeared since the last check:**`);
      for (const c of newCourses) say(`- ${c.name} (${c.status})`);
    }
  } else {
    say();
    say('_First run — recording the current course list as the baseline._');
  }
  if (unopened.length) {
    say();
    say('Not yet open (expected before classes start; tools will 403 until published):');
    for (const c of unopened) say(`- ${c.name}`);
  }
}
say();

// 3. Do the per-course tools actually work against the new term?
say('## Per-course spot check');
say();
const targets = (courses.courses ?? []).filter(
  (c) => !c.isAssisting && c.status !== 'not_yet_open',
);
if (targets.length === 0) {
  say('No open student courses to probe yet.');
} else {
  say('| course | assignments | grade items | modules | forums |');
  say('|---|---|---|---|---|');
  for (const c of targets) {
    const [a, g, m, f] = await Promise.all([
      call('list_assignments', { course: c.courseId }),
      call('get_grades', { course: c.courseId }),
      call('list_modules', { course: c.courseId }),
      call('list_forums', { course: c.courseId }),
    ]);
    const cell = (r, key) => (r.error ? 'ERROR' : (r[key] ?? 0));
    say(
      `| ${c.name} | ${cell(a, 'count')} | ${cell(g, 'count')} | ${cell(m, 'count')} | ${cell(f, 'count')} |`,
    );
    for (const [label, r] of [
      ['list_assignments', a],
      ['get_grades', g],
      ['list_modules', m],
      ['list_forums', f],
    ]) {
      if (r.error) flag(`${label} failed on "${c.name}": ${r.error.slice(0, 160)}`);
    }
  }
}
say();

// 4. Deadlines — the thing this is all for.
say('## Upcoming deadlines (next 30 days)');
say();
const due = await call('get_upcoming_deadlines', { days: 30 });
if (due.error) {
  flag(`get_upcoming_deadlines failed: ${due.error}`);
} else if (!due.count) {
  say(due.note ?? 'Nothing due.');
} else {
  for (const e of due.events.slice(0, 25)) {
    say(`- ${e.when?.slice(0, 16) ?? '?'} — ${e.course}: ${e.title} (${e.due})`);
  }
}
say();

await finish((courses.courses ?? []).map((c) => c.courseId));

async function finish(coursesSeen = null) {
  say('---');
  say(
    needsAttention
      ? 'Result: **needs attention** — see the unchecked boxes above.'
      : newCourses.length
        ? `Result: ${newCourses.length} new course(s) appeared.`
        : 'Result: all good, nothing new.',
  );

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, lines.join('\n'), 'utf8');

  // Only record known courses on a run that actually saw the list, so an
  // auth failure can't wipe the baseline and fake a "new term" next time.
  if (coursesSeen) {
    await writeFile(
      statePath,
      JSON.stringify(
        { lastRun: new Date().toISOString(), knownCourseIds: coursesSeen },
        null,
        2,
      ),
      'utf8',
    );
  }
  console.log(`\nReport written to ${reportPath}`);

  await client.close();
  process.exit(needsAttention ? 1 : newCourses.length ? 2 : 0);
}
