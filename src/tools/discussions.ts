import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { D2LApiError, type D2LClient } from '../api/client.js';
import type {
  DiscussionPost,
  DiscussionTopic,
  Forum,
  WhoAmI,
} from '../api/types.js';
import { consume, stage } from '../confirm.js';
import { resolveOrgUnitId } from './courses.js';
import { formatDate, guard, ok, relativeTo, toText } from './shared.js';

const courseRef = z
  .union([z.string(), z.number()])
  .describe('Course id from list_courses, or part of the course name/code.');

/** Matches D2L's RichTextInput block. */
function richText(body: string, isHtml: boolean) {
  return { Content: body, Type: isHtml ? 'Html' : 'Text' };
}

/** Used to flag which posts in a thread are the user's own. */
async function fetchCurrentUserId(client: D2LClient): Promise<number | null> {
  try {
    const me = await client.get<WhoAmI>(await client.lp('/users/whoami'), {
      cacheSeconds: 3600,
    });
    const id = Number(me.Identifier);
    return Number.isNaN(id) ? null : id;
  } catch {
    return null;
  }
}

async function fetchTopic(
  client: D2LClient,
  orgUnitId: number,
  forumId: number,
  topicId: number,
): Promise<DiscussionTopic> {
  const path = await client.le(
    `/${orgUnitId}/discussions/forums/${forumId}/topics/${topicId}`,
  );
  return client.get<DiscussionTopic>(path, { cacheSeconds: 300 });
}

export function register(server: McpServer, client: D2LClient): void {
  server.registerTool(
    'list_forums',
    {
      title: 'List discussion forums',
      description: 'Lists the discussion forums in a course.',
      inputSchema: { course: courseRef },
    },
    async ({ course }) =>
      guard(async () => {
        const orgUnitId = await resolveOrgUnitId(client, course);
        const path = await client.le(`/${orgUnitId}/discussions/forums/`);
        const forums = await client.get<Forum[]>(path, { cacheSeconds: 600 });
        return ok({
          courseId: orgUnitId,
          count: forums.length,
          forums: forums
            .filter((f) => !f.IsHidden)
            .map((f) => ({
              forumId: f.ForumId,
              name: f.Name,
              description: toText(f.Description),
              isLocked: f.IsLocked,
            })),
        });
      }),
  );

  server.registerTool(
    'list_topics',
    {
      title: 'List discussion topics in a forum',
      description:
        'Lists the topics (individual discussion threads boards) inside a forum, ' +
        'including whether you must post before seeing others\' replies.',
      inputSchema: {
        course: courseRef,
        forumId: z.number().describe('Forum id from list_forums.'),
      },
    },
    async ({ course, forumId }) =>
      guard(async () => {
        const orgUnitId = await resolveOrgUnitId(client, course);
        const path = await client.le(
          `/${orgUnitId}/discussions/forums/${forumId}/topics/`,
        );
        const topics = await client.get<DiscussionTopic[]>(path, { cacheSeconds: 300 });
        return ok({
          courseId: orgUnitId,
          forumId,
          count: topics.length,
          topics: topics
            .filter((t) => !t.IsHidden)
            .map((t) => ({
              topicId: t.TopicId,
              name: t.Name,
              description: toText(t.Description),
              isLocked: t.IsLocked,
              mustPostToParticipate: t.MustPostToParticipate ?? false,
              scoreOutOf: t.ScoreOutOf ?? null,
              endDate: formatDate(t.EndDate),
              due: relativeTo(t.EndDate),
            })),
        });
      }),
  );

  server.registerTool(
    'read_posts',
    {
      title: 'Read posts in a discussion topic',
      description:
        'Reads the posts in a discussion topic so their content can be summarised ' +
        'or replied to. Returns threading information via parentPostId.',
      inputSchema: {
        course: courseRef,
        forumId: z.number().describe('Forum id from list_forums.'),
        topicId: z.number().describe('Topic id from list_topics.'),
        limit: z
          .number()
          .min(1)
          .max(200)
          .optional()
          .describe('Max posts to return. Default 50.'),
      },
    },
    async ({ course, forumId, topicId, limit }) =>
      guard(async () => {
        const orgUnitId = await resolveOrgUnitId(client, course);
        const path = await client.le(
          `/${orgUnitId}/discussions/forums/${forumId}/topics/${topicId}/posts/`,
        );

        let posts: DiscussionPost[];
        try {
          posts = await client.get<DiscussionPost[]>(path, { cacheSeconds: 60 });
        } catch (error) {
          // Brightspace answers 403 on must-post-first topics until you post.
          // Reading the topic itself can be forbidden too, so treat a failed
          // lookup as "unknown" rather than letting it mask the real cause.
          if (error instanceof D2LApiError && error.status === 403) {
            const topic = await fetchTopic(client, orgUnitId, forumId, topicId).catch(
              () => null,
            );
            throw new Error(
              topic?.MustPostToParticipate
                ? `"${topic.Name}" requires you to post before you can read anyone ` +
                  `else's replies, so myCourses is withholding them. Post first with ` +
                  `create_discussion_post, then read.`
                : `myCourses returned 403 for the posts in this topic. The usual cause ` +
                  `is a "must post before viewing replies" setting — post first with ` +
                  `create_discussion_post, then read. It can also mean the topic is ` +
                  `closed or not visible to you.`,
            );
          }
          throw error;
        }

        const currentUserId = await fetchCurrentUserId(client);
        const visible = posts
          .filter((p) => !p.IsDeleted)
          .sort((a, b) => a.DatePosted.localeCompare(b.DatePosted))
          .slice(0, limit ?? 50);

        return ok({
          courseId: orgUnitId,
          forumId,
          topicId,
          count: visible.length,
          posts: visible.map((p) => ({
            postId: p.PostId,
            parentPostId: p.ParentPostId,
            threadId: p.ThreadId,
            author: p.IsAnonymous
              ? 'Anonymous'
              : (p.PostingUserDisplayName ?? null),
            isMine: p.PostingUserId != null && p.PostingUserId === currentUserId,
            postedAt: formatDate(p.DatePosted),
            posted: relativeTo(p.DatePosted),
            subject: p.Subject,
            message: toText(p.Message),
            replyCount: p.ReplyPostIds?.length ?? 0,
            attachments: p.Attachments?.map((a) => a.FileName) ?? [],
            isPinned: p.ThreadIsPinned ?? false,
          })),
        });
      }),
  );

  const writeSchema = {
    course: courseRef,
    forumId: z.number().describe('Forum id from list_forums.'),
    topicId: z.number().describe('Topic id from list_topics.'),
    subject: z.string().optional().describe('Post subject line.'),
    message: z.string().describe('The post body, written by the user.'),
    isHtml: z
      .boolean()
      .optional()
      .describe('Treat message as HTML rather than plain text. Default false.'),
    confirmToken: z
      .string()
      .optional()
      .describe('Omit on the first call; pass the preview token to actually post.'),
  };

  server.registerTool(
    'create_discussion_post',
    {
      title: 'Start a new discussion thread (requires confirmation)',
      description:
        'Creates a new top-level thread in a discussion topic. Posting is public ' +
        'and cannot be silently undone, so this is two-step: call without ' +
        'confirmToken to get a preview of the exact text that would be posted, ' +
        'show it to the user, then call again with the token once they approve.',
      inputSchema: writeSchema,
    },
    async ({ course, forumId, topicId, subject, message, isHtml, confirmToken }) =>
      guard(async () => {
        if (confirmToken) {
          return ok(await consume('create_discussion_post', confirmToken));
        }

        const orgUnitId = await resolveOrgUnitId(client, course);
        const topic = await fetchTopic(client, orgUnitId, forumId, topicId);
        if (topic.IsLocked) {
          throw new Error(`Discussion topic "${topic.Name}" is locked.`);
        }

        const path = await client.le(
          `/${orgUnitId}/discussions/forums/${forumId}/topics/${topicId}/posts/`,
        );
        const payload = {
          ParentPostId: null,
          Subject: subject ?? topic.Name,
          Message: richText(message, isHtml ?? false),
          IsAnonymous: false,
        };

        return ok(
          stage(
            'create_discussion_post',
            {
              course: { courseId: orgUnitId },
              topic: { forumId, topicId, name: topic.Name },
              willPost: {
                subject: payload.Subject,
                message,
                format: isHtml ? 'Html' : 'Text',
                characters: message.length,
              },
              visibility: 'Visible to the instructor and everyone in the course.',
            },
            async () => {
              const created = await client.postJson<DiscussionPost>(path, payload);
              return {
                status: 'posted',
                courseId: orgUnitId,
                forumId,
                topicId,
                postId: created?.PostId ?? null,
                postedAt: new Date().toISOString(),
              };
            },
          ),
        );
      }),
  );

  server.registerTool(
    'reply_to_post',
    {
      title: 'Reply to a discussion post (requires confirmation)',
      description:
        'Replies to an existing post in a discussion topic. Same two-step ' +
        'confirmation as create_discussion_post: preview first, then confirm.',
      inputSchema: {
        ...writeSchema,
        parentPostId: z
          .number()
          .describe('postId of the post being replied to, from read_posts.'),
      },
    },
    async ({
      course,
      forumId,
      topicId,
      parentPostId,
      subject,
      message,
      isHtml,
      confirmToken,
    }) =>
      guard(async () => {
        if (confirmToken) {
          return ok(await consume('reply_to_post', confirmToken));
        }

        const orgUnitId = await resolveOrgUnitId(client, course);
        const topic = await fetchTopic(client, orgUnitId, forumId, topicId);
        if (topic.IsLocked) {
          throw new Error(`Discussion topic "${topic.Name}" is locked.`);
        }

        const postsPath = await client.le(
          `/${orgUnitId}/discussions/forums/${forumId}/topics/${topicId}/posts/`,
        );
        const posts = await client.get<DiscussionPost[]>(postsPath, { cacheSeconds: 0 });
        const parent = posts.find((p) => p.PostId === parentPostId);
        if (!parent) {
          throw new Error(
            `No post with id ${parentPostId} in that topic. Run read_posts first.`,
          );
        }

        const payload = {
          ParentPostId: parentPostId,
          Subject: subject ?? `RE: ${parent.Subject ?? topic.Name}`,
          Message: richText(message, isHtml ?? false),
          IsAnonymous: false,
        };

        return ok(
          stage(
            'reply_to_post',
            {
              course: { courseId: orgUnitId },
              topic: { forumId, topicId, name: topic.Name },
              replyingTo: {
                postId: parent.PostId,
                author: parent.IsAnonymous
                  ? 'Anonymous'
                  : (parent.PostingUserDisplayName ?? 'unknown'),
                excerpt: toText(parent.Message).slice(0, 300),
              },
              willPost: {
                subject: payload.Subject,
                message,
                format: isHtml ? 'Html' : 'Text',
                characters: message.length,
              },
              visibility: 'Visible to the instructor and everyone in the course.',
            },
            async () => {
              const created = await client.postJson<DiscussionPost>(postsPath, payload);
              return {
                status: 'posted',
                courseId: orgUnitId,
                forumId,
                topicId,
                parentPostId,
                postId: created?.PostId ?? null,
                postedAt: new Date().toISOString(),
              };
            },
          ),
        );
      }),
  );
}
