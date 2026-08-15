import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { D2LClient } from '../api/client.js';
import type { GradeValue } from '../api/types.js';
import { fetchMyCourses, resolveOrgUnitId } from './courses.js';
import { formatDate, guard, ok, toText } from './shared.js';

const courseRef = z
  .union([z.string(), z.number()])
  .describe('Course id from list_courses, or part of the course name/code.');

function summarize(grade: GradeValue) {
  const numerator = grade.PointsNumerator ?? null;
  const denominator = grade.PointsDenominator ?? null;
  return {
    item: grade.GradeObjectName,
    gradeObjectId: grade.GradeObjectIdentifier,
    type: grade.GradeObjectTypeName,
    displayed: grade.DisplayedGrade,
    points: numerator != null && denominator != null ? `${numerator}/${denominator}` : null,
    percent:
      numerator != null && denominator ? Math.round((numerator / denominator) * 1000) / 10 : null,
    weightedPoints:
      grade.WeightedNumerator != null && grade.WeightedDenominator != null
        ? `${grade.WeightedNumerator}/${grade.WeightedDenominator}`
        : null,
    feedback: toText(grade.Comments) || null,
    lastModified: formatDate(grade.LastModified),
  };
}

export function register(server: McpServer, client: D2LClient): void {
  server.registerTool(
    'get_grades',
    {
      title: 'Get my grades',
      description:
        'Returns the user\'s own grade items for a course — score, percentage and ' +
        'any instructor feedback. Pass allCourses to sweep every active course at once.',
      inputSchema: {
        course: courseRef.optional(),
        allCourses: z
          .boolean()
          .optional()
          .describe('Fetch grades for every active course instead of just one.'),
      },
    },
    async ({ course, allCourses }) =>
      guard(async () => {
        if (!allCourses && course == null) {
          throw new Error('Pass either `course` or `allCourses: true`.');
        }

        const targets = allCourses
          ? (await fetchMyCourses(client)).map((c) => ({
              courseId: c.OrgUnit.Id,
              name: c.OrgUnit.Name,
            }))
          : [{ courseId: await resolveOrgUnitId(client, course!), name: null }];

        const results = [];
        for (const target of targets) {
          const path = await client.le(
            `/${target.courseId}/grades/values/myGradeValues/`,
          );
          try {
            const grades = await client.get<GradeValue[]>(path, { cacheSeconds: 60 });
            results.push({
              ...target,
              count: grades.length,
              grades: grades.map(summarize),
            });
          } catch (error) {
            // One locked-down course shouldn't sink an all-courses sweep.
            results.push({
              ...target,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        return ok(allCourses ? { courses: results } : results[0]);
      }),
  );

  server.registerTool(
    'get_final_grade',
    {
      title: 'Get my final grade for a course',
      description: "Returns the user's calculated final grade for one course.",
      inputSchema: { course: courseRef },
    },
    async ({ course }) =>
      guard(async () => {
        const orgUnitId = await resolveOrgUnitId(client, course);
        const path = await client.le(
          `/${orgUnitId}/grades/final/values/myGradeValue`,
        );
        const grade = await client.get<GradeValue>(path, { cacheSeconds: 60 });
        return ok({ courseId: orgUnitId, ...summarize(grade) });
      }),
  );
}
