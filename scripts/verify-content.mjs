#!/usr/bin/env node
// Proves a write dry run leaves no trace, and exercises content download plus
// text extraction end to end. Discovers a suitable course from whatever the
// signed-in account is enrolled in, so it works for any user or school.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const client = new Client({ name: 'verify-content', version: '0.0.0' });
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

// Widen the scope until we find courses to work with — a between-terms account
// may have nothing current.
async function findCourses() {
  for (const scope of ['current', 'recent', 'all']) {
    const r = await call('list_courses', { scope });
    if ((r.courses ?? []).length) return r.courses;
  }
  return [];
}

const courses = await findCourses();
if (!courses.length) {
  console.log('No courses found for this account — nothing to verify.');
  await client.close();
  process.exit(0);
}

console.log('=== finding a course with an assignment ===');
let target = null;
for (const c of courses) {
  const a = await call('list_assignments', { course: c.courseId });
  if ((a.count ?? 0) > 0) {
    target = { course: c, assignment: a.assignments[0] };
    break;
  }
}

if (!target) {
  console.log('No course with assignments found.');
} else {
  const { course, assignment } = target;
  console.log(`${course.name} -> "${assignment.name}" (#${assignment.assignmentId})`);

  console.log('\n=== submissions before the dry run ===');
  const before = await call('list_my_submissions', {
    course: course.courseId,
    assignmentId: assignment.assignmentId,
  });
  console.log(before.error ? `error: ${before.error}` : `count: ${before.count}`);

  console.log('\n=== submit_assignment with NO confirmToken ===');
  const preview = await call('submit_assignment', {
    course: course.courseId,
    assignmentId: assignment.assignmentId,
    filePaths: [join(root, 'README.md')],
    comment: 'dry run — must not be sent',
  });
  console.log(`status: ${preview.status ?? preview.error}`);
  console.log(`token issued: ${Boolean(preview.confirmToken)}`);

  console.log('\n=== submissions after the dry run ===');
  const after = await call('list_my_submissions', {
    course: course.courseId,
    assignmentId: assignment.assignmentId,
  });
  if (after.error) {
    console.log(`error: ${after.error}`);
  } else {
    console.log(`count: ${after.count}`);
    console.log(
      before.count === after.count
        ? 'CLEAN — the dry run wrote nothing.'
        : 'PROBLEM — the submission count changed!',
    );
  }

  console.log('\n=== a forged confirmToken is rejected ===');
  const bogus = await call('submit_assignment', {
    course: course.courseId,
    assignmentId: assignment.assignmentId,
    filePaths: [join(root, 'README.md')],
    confirmToken: 'this-token-is-not-real',
  });
  console.log(bogus.error ?? 'PROBLEM — a forged token was accepted!');
}

console.log('\n=== content tree: find and extract a downloadable file ===');
let found = null;
outer: for (const c of courses) {
  const mods = await call('list_modules', { course: c.courseId });
  for (const m of mods.modules ?? []) {
    if (m.kind !== 'module') continue;
    const detail = await call('get_module', {
      course: c.courseId,
      moduleId: m.moduleId,
    });
    const file = (detail.items ?? []).find(
      (i) => i.kind === 'topic' && /\.(pdf|docx)$/i.test(i.url ?? ''),
    );
    if (file) {
      found = { course: c, module: m, topic: file };
      break outer;
    }
  }
}

if (!found) {
  console.log('No pdf/docx topic found in any accessible course.');
} else {
  console.log(`${found.course.name} > ${found.module.title} > "${found.topic.title}"`);
  const dl = await call('download_topic_file', {
    course: found.course.courseId,
    topicId: found.topic.topicId,
    maxChars: 600,
  });
  if (dl.error) {
    console.log(`error: ${dl.error}`);
  } else {
    console.log(`filename:   ${dl.filename}`);
    console.log(`sizeBytes:  ${dl.sizeBytes}`);
    console.log(`extractor:  ${dl.extractor}`);
    console.log(`fullLength: ${dl.fullLength}`);
    console.log(`\n--- first 600 chars ---\n${dl.text ?? dl.note}`);
  }
}

await client.close();
