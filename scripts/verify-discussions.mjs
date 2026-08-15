#!/usr/bin/env node
// Exercises the discussion read path and dry-runs a reply without posting it.
// Hunts for a topic with real activity rather than hardcoding ids, so it works
// for any user or school.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const client = new Client({ name: 'verify-discussions', version: '0.0.0' });
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

// Discussion activity is often in a past term, so search the full history —
// but cap it, since this walks forums and topics per course. list_courses
// returns most-recent-first.
const SCAN_LIMIT = 20;
const all = await call('list_courses', { scope: 'all' });
const courses = (all.courses ?? []).slice(0, SCAN_LIMIT);
console.log(
  `scanning ${courses.length} of ${all.count ?? 0} course(s) for discussion activity...\n`,
);

let live = null; // a topic with readable posts
let gated = null; // a topic that refuses to show posts

outer: for (const c of courses) {
  const forums = await call('list_forums', { course: c.courseId });
  for (const forum of forums.forums ?? []) {
    const topics = await call('list_topics', {
      course: c.courseId,
      forumId: forum.forumId,
    });
    for (const topic of topics.topics ?? []) {
      const posts = await call('read_posts', {
        course: c.courseId,
        forumId: forum.forumId,
        topicId: topic.topicId,
        limit: 4,
      });
      if (posts.error) {
        gated ??= { course: c, forum, topic, error: posts.error };
        continue;
      }
      if (posts.count > 0) {
        live = { course: c, forum, topic, posts };
        break outer;
      }
    }
  }
}

console.log('=== read_posts on a topic with real activity ===');
if (!live) {
  console.log('No topic with readable posts found in any course.');
} else {
  console.log(`${live.course.name} > ${live.forum.name} > "${live.topic.name}"`);
  console.log(`${live.posts.count} post(s)\n`);
  for (const p of live.posts.posts) {
    console.log(`#${p.postId} parent=${p.parentPostId} by ${p.author}${p.isMine ? ' (me)' : ''}`);
    console.log(`  subject : ${p.subject}`);
    console.log(`  posted  : ${p.posted}`);
    console.log(`  replies : ${p.replyCount}`);
    console.log(`  message : ${(p.message ?? '').replace(/\s+/g, ' ').slice(0, 110)}`);
    console.log('');
  }
}

console.log('=== a topic that withholds posts (expect a helpful refusal) ===');
if (!gated) {
  console.log('None found — every readable topic returned posts.');
} else {
  console.log(`${gated.course.name} > "${gated.topic.name}"`);
  console.log(gated.error);
}

console.log('\n=== reply_to_post DRY RUN (no confirmToken) ===');
if (!live) {
  console.log('Skipped — no topic to reply to.');
} else {
  const parent = live.posts.posts[0];
  const preview = await call('reply_to_post', {
    course: live.course.courseId,
    forumId: live.forum.forumId,
    topicId: live.topic.topicId,
    parentPostId: parent.postId,
    message: 'dry run — this must not be posted',
  });
  console.log(`status: ${preview.status ?? preview.error}`);
  if (preview.willDo) console.log(JSON.stringify(preview.willDo, null, 2));
  console.log('\n>>> No confirmToken passed, so nothing was posted.');
}

await client.close();
