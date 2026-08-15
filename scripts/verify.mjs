#!/usr/bin/env node
// End-to-end check of the read path against live myCourses, plus a
// dry-run of both write tools to prove they preview instead of writing.
// Requires a stored session (`node dist/cli.js login`).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const client = new Client({ name: 'verify', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'dist', 'index.js')],
  }),
);

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) return { error: text };
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const line = (s) => console.log(`\n=== ${s} ===`);

line('whoami');
console.log(await call('whoami'));

line('list_courses (default scope)');
const courses = await call('list_courses');
console.log(
  `scope=${courses.scope}  showing ${courses.count} of ${courses.totalEnrolments} enrolments`,
);
if (courses.note) console.log(`note: ${courses.note}`);
for (const c of courses.courses ?? []) {
  console.log(`  ${c.courseId}  ${c.name}  [${c.role}]  ends=${c.endDate?.slice(0, 10) ?? 'ongoing'}`);
}

line('get_upcoming_deadlines (21 days)');
const due = await call('get_upcoming_deadlines', { days: 21 });
console.log(`${due.count} event(s) across ${due.coursesSearched} course(s)`);
for (const e of (due.events ?? []).slice(0, 12)) {
  console.log(`  ${e.when ?? '?'}  ${e.due ?? ''}  ${e.course} — ${e.title}`);
}

// Pick a course that actually has assignments, so the dry run has a target.
let first = courses.courses?.[0];
for (const candidate of courses.courses ?? []) {
  const probe = await call('list_assignments', { course: candidate.courseId });
  if ((probe.count ?? 0) > 0) {
    first = candidate;
    break;
  }
}

if (first) {
  line(`list_assignments — ${first.name}`);
  const a = await call('list_assignments', { course: first.courseId });
  console.log(`${a.count} assignment(s)`);
  for (const x of (a.assignments ?? []).slice(0, 10)) {
    console.log(
      `  #${x.assignmentId}  ${x.name}  due=${x.dueDate ?? 'none'} (${x.due ?? '-'})  type=${x.submissionType}  outOf=${x.outOf}`,
    );
  }

  line(`get_grades — ${first.name}`);
  const g = await call('get_grades', { course: first.courseId });
  console.log(`${g.count ?? 0} grade item(s)`);
  for (const x of (g.grades ?? []).slice(0, 10)) {
    console.log(`  ${x.item}: ${x.displayed ?? '—'} ${x.points ? `(${x.points})` : ''}`);
  }

  line(`list_modules — ${first.name}`);
  const m = await call('list_modules', { course: first.courseId });
  console.log(`${m.count ?? 0} module(s)`);
  for (const x of (m.modules ?? []).slice(0, 8)) {
    console.log(`  #${x.moduleId ?? x.topicId}  ${x.title}`);
  }

  line(`list_forums — ${first.name}`);
  const f = await call('list_forums', { course: first.courseId });
  console.log(`${f.count ?? 0} forum(s)`);
  for (const x of (f.forums ?? []).slice(0, 8)) {
    console.log(`  #${x.forumId}  ${x.name}`);
  }

  line('WRITE DRY RUN — submit_assignment with no confirmToken');
  const target = (await call('list_assignments', { course: first.courseId }))
    .assignments?.[0];
  if (target) {
    const preview = await call('submit_assignment', {
      course: first.courseId,
      assignmentId: target.assignmentId,
      filePaths: [join(root, 'README.md')],
      comment: 'dry run — should not be sent',
    });
    console.log(`status: ${preview.status ?? preview.error}`);
    console.log(`token issued: ${Boolean(preview.confirmToken)}`);
    if (preview.willDo) {
      console.log(JSON.stringify(preview.willDo, null, 2));
    }
    console.log('\n>>> No confirmToken was passed, so NOTHING was submitted.');
  } else {
    console.log('No assignment available to preview against.');
  }

  line('course name resolution (fuzzy)');
  const byName = await call('list_assignments', {
    course: first.name.split(' ').slice(0, 2).join(' '),
  });
  console.log(
    byName.error
      ? `error: ${byName.error}`
      : `resolved "${first.name.split(' ').slice(0, 2).join(' ')}" -> courseId ${byName.courseId}`,
  );
}

await client.close();
