import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { D2LClient } from '../api/client.js';
import type { AuthProvider } from '../auth/provider.js';
import type { MyOrgUnitInfo, WhoAmI } from '../api/types.js';
import { formatDate, guard, ok } from './shared.js';

const COURSE_OFFERING = 3;

const DAY_MS = 86_400_000;

/**
 * Grace period after a term ends. Final grades and feedback keep landing for a
 * couple of weeks, so a finished course stays in the default view that long.
 */
const GRACE_DAYS = 21;

/** How far back "recent" reaches, for chasing an older term's grades. */
const RECENT_DAYS = 120;

/**
 * A course with no end date never ages out on its own, so fall back to whether
 * it has actually been opened lately. This is what separates a live self-paced
 * course from one abandoned in 2021.
 */
const UNTOUCHED_DAYS = { current: 180, recent: 365 };

export type CourseScope = 'current' | 'recent' | 'all';

/**
 * Note: Access.IsActive is NOT a "this term" flag — Brightspace reports true
 * for every course that hasn't been archived, so it returns years of history.
 * End date is the only reliable signal for what the user is actually taking.
 */
export async function fetchMyCourses(
  client: D2LClient,
  opts: { scope?: CourseScope } = {},
): Promise<MyOrgUnitInfo[]> {
  const path = await client.lp('/enrollments/myenrollments/');
  const all = await client.getAllPages<MyOrgUnitInfo>(path, {
    cacheSeconds: 600,
    query: { orgUnitTypeId: COURSE_OFFERING },
  });

  const scope = opts.scope ?? 'current';
  if (scope === 'all') return sortByRecency(all);

  const now = Date.now();
  const endCutoff = now - (scope === 'current' ? GRACE_DAYS : RECENT_DAYS) * DAY_MS;
  const touchedCutoff = now - UNTOUCHED_DAYS[scope] * DAY_MS;

  // Unpublished courses are deliberately kept: a Fall course appears days
  // before the instructor opens it, and seeing it listed is the point.
  return sortByRecency(
    all.filter((e) => {
      const end = e.Access?.EndDate;
      if (end) return new Date(end).getTime() > endCutoff;
      const touched = e.Access?.LastAccessed;
      return Boolean(touched) && new Date(touched!).getTime() > touchedCutoff;
    }),
  );
}

/** Ongoing courses first, then most recently ending. */
function sortByRecency(courses: MyOrgUnitInfo[]): MyOrgUnitInfo[] {
  return [...courses].sort((a, b) => {
    const aEnd = a.Access?.EndDate;
    const bEnd = b.Access?.EndDate;
    if (!aEnd && !bEnd) return 0;
    if (!aEnd) return -1;
    if (!bEnd) return 1;
    return bEnd.localeCompare(aEnd);
  });
}

/**
 * Accepts a numeric org unit id or a chunk of a course name/code, so callers
 * can say "Data Structures" instead of hunting for 1234567.
 */
export async function resolveOrgUnitId(
  client: D2LClient,
  ref: string | number,
): Promise<number> {
  if (typeof ref === 'number') return ref;
  if (/^\d+$/.test(ref.trim())) return Number(ref.trim());

  const needle = ref.trim().toLowerCase();
  const match = (c: MyOrgUnitInfo) =>
    c.OrgUnit.Name?.toLowerCase().includes(needle) ||
    c.OrgUnit.Code?.toLowerCase().includes(needle);

  // Course names repeat across years, so try this term first and only widen
  // the search if nothing current matches. Otherwise "Big Data" is ambiguous
  // between the course being taken now and the one taken three years ago.
  const recent = (await fetchMyCourses(client, { scope: 'recent' })).filter(match);
  if (recent.length === 1) return recent[0]!.OrgUnit.Id;

  const candidates =
    recent.length > 1
      ? recent
      : (await fetchMyCourses(client, { scope: 'all' })).filter(match);

  if (candidates.length === 1) return candidates[0]!.OrgUnit.Id;
  if (candidates.length === 0) {
    throw new Error(
      `No enrolled course matches "${ref}". Run list_courses to see the exact names.`,
    );
  }

  const names = candidates
    .slice(0, 12)
    .map((m) => {
      const ends = m.Access?.EndDate?.slice(0, 10) ?? 'ongoing';
      return `  ${m.OrgUnit.Id} — ${m.OrgUnit.Name} (ends ${ends})`;
    })
    .join('\n');
  throw new Error(
    `"${ref}" matches ${candidates.length} courses. Pass a courseId instead:\n${names}`,
  );
}

/** Roles where the user is running the course rather than taking it. */
const STAFF_ROLES = /teaching assistant|support staff|instructor|grader|designer/i;

export type CourseStatus =
  | 'in_session'
  | 'upcoming'
  | 'not_yet_open'
  | 'recently_ended';

function courseStatus(entry: MyOrgUnitInfo): CourseStatus {
  const now = Date.now();
  const start = entry.Access?.StartDate;
  const end = entry.Access?.EndDate;

  if (end && new Date(end).getTime() < now) return 'recently_ended';
  if (start && new Date(start).getTime() > now) return 'upcoming';
  // Brightspace lists a course before the instructor publishes it.
  if (entry.Access?.CanAccess === false) return 'not_yet_open';
  return 'in_session';
}

export function summarizeCourse(entry: MyOrgUnitInfo) {
  const role = entry.Access?.ClasslistRoleName ?? null;
  const status = courseStatus(entry);

  return {
    courseId: entry.OrgUnit.Id,
    name: entry.OrgUnit.Name,
    code: entry.OrgUnit.Code,
    role,
    // Flags the 8 courses being assisted rather than taken, so "my courses"
    // never silently mixes coursework with TA duties.
    isAssisting: role ? STAFF_ROLES.test(role) : false,
    status,
    ...(status === 'not_yet_open'
      ? { note: 'Listed but not published by the instructor yet; most tools will 403 until it opens.' }
      : {}),
    startDate: formatDate(entry.Access?.StartDate),
    endDate: formatDate(entry.Access?.EndDate),
    lastAccessed: formatDate(entry.Access?.LastAccessed),
  };
}

export function register(
  server: McpServer,
  client: D2LClient,
  auth: AuthProvider,
): void {
  server.registerTool(
    'auth_status',
    {
      title: 'Check myCourses authentication',
      description:
        'Reports whether the server currently holds a usable myCourses session, ' +
        'which auth provider is in use, and how old the session is. Call this ' +
        'first when other tools report authentication errors.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const status = await auth.describe();
        const versions = await client
          .apiVersions()
          .then((map) => Object.fromEntries(map))
          .catch(() => null);
        return ok({ ...status, apiVersions: versions });
      }),
  );

  server.registerTool(
    'whoami',
    {
      title: 'Who am I in myCourses',
      description:
        'Returns the signed-in myCourses user (name, username, internal user id). ' +
        'Useful as a quick connectivity check.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const path = await client.lp('/users/whoami');
        return ok(await client.get<WhoAmI>(path, { cacheSeconds: 3600 }));
      }),
  );

  server.registerTool(
    'list_courses',
    {
      title: 'List my courses',
      description:
        'Lists the courses the user is enrolled in, with the courseId that every ' +
        'other tool needs. Defaults to the current term — courses in session, ' +
        'ones starting soon, and any that ended in the last three weeks. Only ' +
        'widen the scope when the user asks about older courses.',
      inputSchema: {
        scope: z
          .enum(['current', 'recent', 'all'])
          .optional()
          .describe(
            '"current" (default) = this term, including upcoming courses and a ' +
              '3-week grace after one ends. "recent" = also the last ~4 months. ' +
              '"all" = every course ever enrolled in.',
          ),
        includeAssisting: z
          .boolean()
          .optional()
          .describe(
            'Include courses where the user is a TA or staff rather than a ' +
              'student. Default true; set false for "what am I taking".',
          ),
      },
    },
    async ({ scope, includeAssisting }) =>
      guard(async () => {
        const chosen = scope ?? 'current';
        const all = await fetchMyCourses(client, { scope: 'all' });
        let courses = (await fetchMyCourses(client, { scope: chosen })).map(
          summarizeCourse,
        );

        const assistingCount = courses.filter((c) => c.isAssisting).length;
        if (includeAssisting === false) {
          courses = courses.filter((c) => !c.isAssisting);
        }

        const hidden = all.length - courses.length;
        return ok({
          scope: chosen,
          count: courses.length,
          totalEnrolments: all.length,
          ...(assistingCount > 0
            ? { assistingCount, studentCount: courses.length - assistingCount }
            : {}),
          ...(hidden > 0
            ? {
                note:
                  `${hidden} course(s) outside the "${chosen}" scope are hidden. ` +
                  `Use scope "recent" or "all" to see earlier terms.`,
              }
            : {}),
          courses,
        });
      }),
  );
}
