import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { D2LClient } from '../api/client.js';
import type { CalendarEvent } from '../api/types.js';
import { fetchMyCourses } from './courses.js';
import { formatDate, guard, ok, relativeTo, stripHtml } from './shared.js';

export function register(server: McpServer, client: D2LClient): void {
  server.registerTool(
    'get_upcoming_deadlines',
    {
      title: 'Get upcoming deadlines across all courses',
      description:
        'The single most useful tool for "what is due soon". Pulls calendar ' +
        'events across every active course in one call and returns them sorted ' +
        'by date, so there is no need to loop over courses manually.',
      inputSchema: {
        days: z
          .number()
          .min(1)
          .max(120)
          .optional()
          .describe('How far ahead to look. Default 14 days.'),
        includePast: z
          .boolean()
          .optional()
          .describe('Also include the last 7 days, to catch things just missed.'),
        dueDatesOnly: z
          .boolean()
          .optional()
          .describe('Restrict to due-date events rather than all calendar entries.'),
      },
    },
    async ({ days, includePast, dueDatesOnly }) =>
      guard(async () => {
        const courses = await fetchMyCourses(client, { scope: 'current' });
        if (courses.length === 0) {
          return ok({
            count: 0,
            events: [],
            note:
              'No courses are currently in session, so there is nothing to be due. ' +
              'Run list_courses with scope "all" to see past enrolments.',
          });
        }

        const names = new Map(courses.map((c) => [c.OrgUnit.Id, c.OrgUnit.Name]));
        const start = new Date(
          Date.now() - (includePast ? 7 : 0) * 86_400_000,
        ).toISOString();
        const end = new Date(Date.now() + (days ?? 14) * 86_400_000).toISOString();

        const path = await client.le('/calendar/events/myEvents/');
        const events = await client.getAllPages<CalendarEvent>(path, {
          cacheSeconds: 120,
          query: {
            orgUnitIdsCSV: courses.map((c) => c.OrgUnit.Id).join(','),
            startDateTime: start,
            endDateTime: end,
            ...(dueDatesOnly ? { eventType: 'DueDate' } : {}),
          },
        });

        const sorted = events
          .map((event) => ({
            title: event.Title,
            course: names.get(event.OrgUnitId) ?? event.OrgUnitId,
            courseId: event.OrgUnitId,
            when: formatDate(event.EndDateTime ?? event.StartDateTime),
            due: relativeTo(event.EndDateTime ?? event.StartDateTime),
            type: event.AssociatedEntity?.EntityType ?? null,
            description: event.Description ? stripHtml(event.Description) : null,
          }))
          .sort((a, b) => (a.when ?? '').localeCompare(b.when ?? ''));

        return ok({
          window: { from: start, to: end },
          coursesSearched: courses.length,
          courseNames: courses.map((c) => c.OrgUnit.Name),
          count: sorted.length,
          ...(sorted.length === 0
            ? {
                note:
                  `Nothing scheduled in the next ${days ?? 14} days across the ` +
                  `${courses.length} course(s) currently in session. Try a larger ` +
                  `"days" value if a new term is about to start.`,
              }
            : {}),
          events: sorted,
        });
      }),
  );
}
