import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { D2LClient } from '../api/client.js';
import type { NewsItem } from '../api/types.js';
import { fetchMyCourses, resolveOrgUnitId } from './courses.js';
import { formatDate, guard, ok, relativeTo, toText } from './shared.js';

export function register(server: McpServer, client: D2LClient): void {
  server.registerTool(
    'get_announcements',
    {
      title: 'Get course announcements',
      description:
        'Reads the announcements (news items) instructors have posted. Omit ' +
        '`course` to sweep every active course at once.',
      inputSchema: {
        course: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Course id or name. Omit to check all active courses.'),
        limit: z
          .number()
          .min(1)
          .max(50)
          .optional()
          .describe('Max announcements per course. Default 10.'),
      },
    },
    async ({ course, limit }) =>
      guard(async () => {
        const targets =
          course == null
            ? (await fetchMyCourses(client)).map((c) => ({
                courseId: c.OrgUnit.Id,
                name: c.OrgUnit.Name as string | null,
              }))
            : [
                {
                  courseId: await resolveOrgUnitId(client, course),
                  name: null as string | null,
                },
              ];

        const results = [];
        for (const target of targets) {
          const path = await client.le(`/${target.courseId}/news/`);
          try {
            const items = await client.get<NewsItem[]>(path, { cacheSeconds: 300 });
            const visible = items
              .filter((item) => !item.IsHidden)
              .sort((a, b) => (b.StartDate ?? '').localeCompare(a.StartDate ?? ''))
              .slice(0, limit ?? 10)
              .map((item) => ({
                id: item.Id,
                title: item.Title,
                postedAt: formatDate(item.StartDate),
                posted: relativeTo(item.StartDate),
                body: toText(item.Body),
                attachments: item.Attachments?.map((a) => a.FileName) ?? [],
              }));
            results.push({ ...target, count: visible.length, announcements: visible });
          } catch (error) {
            results.push({
              ...target,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        return ok(course == null ? { courses: results } : results[0]);
      }),
  );
}
