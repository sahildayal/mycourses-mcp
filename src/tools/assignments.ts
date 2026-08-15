import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { D2LClient } from '../api/client.js';
import { guessMimeType, type UploadPart } from '../api/multipart.js';
import {
  SubmissionType,
  type DropboxFolder,
  type DropboxSubmission,
} from '../api/types.js';
import { consume, stage } from '../confirm.js';
import { downloadDir } from '../config.js';
import { resolveOrgUnitId } from './courses.js';
import { formatDate, guard, ok, relativeTo, toText } from './shared.js';

const courseRef = z
  .union([z.string(), z.number()])
  .describe('Course id from list_courses, or part of the course name/code.');

function summarize(folder: DropboxFolder) {
  return {
    assignmentId: folder.Id,
    name: folder.Name,
    dueDate: formatDate(folder.DueDate),
    due: relativeTo(folder.DueDate),
    isOverdue: folder.DueDate ? new Date(folder.DueDate).getTime() < Date.now() : false,
    outOf: folder.Assessment?.ScoreDenominator ?? null,
    submissionType: folder.SubmissionType != null
      ? SubmissionType[folder.SubmissionType] ?? folder.SubmissionType
      : null,
    isGroupAssignment: folder.GroupTypeId != null,
    mySubmissionCount: folder.TotalFiles ?? 0,
    availability: folder.Availability
      ? {
          opens: formatDate(folder.Availability.StartDate),
          closes: formatDate(folder.Availability.EndDate),
        }
      : null,
  };
}

async function fetchFolders(
  client: D2LClient,
  orgUnitId: number,
): Promise<DropboxFolder[]> {
  const path = await client.le(`/${orgUnitId}/dropbox/folders/`);
  const folders = await client.get<DropboxFolder[]>(path, { cacheSeconds: 120 });
  return folders.filter((f) => !f.IsHidden);
}

async function fetchFolder(
  client: D2LClient,
  orgUnitId: number,
  assignmentId: number,
): Promise<DropboxFolder> {
  const folders = await fetchFolders(client, orgUnitId);
  const folder = folders.find((f) => f.Id === assignmentId);
  if (!folder) {
    throw new Error(
      `No visible assignment with id ${assignmentId} in course ${orgUnitId}. ` +
        `Run list_assignments to see valid ids.`,
    );
  }
  return folder;
}

/** Reject submission types the mysubmissions route cannot serve. */
function assertSubmittable(folder: DropboxFolder): void {
  const type = folder.SubmissionType;
  if (type === SubmissionType.OnPaper) {
    throw new Error(
      `"${folder.Name}" is an on-paper assignment — there is nothing to upload.`,
    );
  }
  if (type === SubmissionType.Observed) {
    throw new Error(
      `"${folder.Name}" is an observed assessment and is not submitted through the API.`,
    );
  }
  if (type === SubmissionType.Text) {
    throw new Error(
      `"${folder.Name}" is a text-entry assignment. Brightspace's submission API ` +
        `requires a file, so text-entry assignments have to be submitted in the ` +
        `myCourses web UI. If you want, save the text as a .txt or .html file and ` +
        `check whether the assignment also accepts file uploads.`,
    );
  }
}

export function register(server: McpServer, client: D2LClient): void {
  server.registerTool(
    'list_assignments',
    {
      title: 'List assignments',
      description:
        'Lists assignment folders (dropboxes) for a course with due dates, point ' +
        'values, submission type, and whether they are overdue.',
      inputSchema: {
        course: courseRef,
        onlyUpcoming: z
          .boolean()
          .optional()
          .describe('Hide assignments whose due date has already passed.'),
      },
    },
    async ({ course, onlyUpcoming }) =>
      guard(async () => {
        const orgUnitId = await resolveOrgUnitId(client, course);
        let folders = await fetchFolders(client, orgUnitId);
        if (onlyUpcoming) {
          folders = folders.filter(
            (f) => !f.DueDate || new Date(f.DueDate).getTime() >= Date.now(),
          );
        }
        folders.sort((a, b) => {
          if (!a.DueDate) return 1;
          if (!b.DueDate) return -1;
          return a.DueDate.localeCompare(b.DueDate);
        });
        return ok({
          courseId: orgUnitId,
          count: folders.length,
          assignments: folders.map(summarize),
        });
      }),
  );

  server.registerTool(
    'get_assignment',
    {
      title: 'Get assignment details',
      description:
        'Full detail for one assignment, including the instructions text.',
      inputSchema: {
        course: courseRef,
        assignmentId: z.number().describe('Assignment id from list_assignments.'),
      },
    },
    async ({ course, assignmentId }) =>
      guard(async () => {
        const orgUnitId = await resolveOrgUnitId(client, course);
        const folder = await fetchFolder(client, orgUnitId, assignmentId);
        return ok({
          ...summarize(folder),
          instructions: toText(folder.CustomInstructions),
        });
      }),
  );

  server.registerTool(
    'list_my_submissions',
    {
      title: 'List my submissions for an assignment',
      description:
        'Shows what the user has already submitted to an assignment: files, ' +
        'timestamps and any comment. Use this to check whether something is in ' +
        'before submitting again.',
      inputSchema: {
        course: courseRef,
        assignmentId: z.number().describe('Assignment id from list_assignments.'),
      },
    },
    async ({ course, assignmentId }) =>
      guard(async () => {
        const orgUnitId = await resolveOrgUnitId(client, course);
        const path = await client.le(
          `/${orgUnitId}/dropbox/folders/${assignmentId}/submissions/mysubmissions/`,
        );
        const envelopes = await client.get<DropboxSubmission[]>(path, {
          cacheSeconds: 30,
        });
        const entries = envelopes.flatMap((e) => e.Submissions);
        const feedback = envelopes[0]?.Feedback;
        return ok({
          courseId: orgUnitId,
          assignmentId,
          count: entries.length,
          submissions: entries.map((s) => ({
            submissionId: s.Id,
            submittedAt: formatDate(s.SubmissionDate),
            submitted: relativeTo(s.SubmissionDate),
            comment: toText(s.Comment),
            files: s.Files.map((f) => ({
              fileId: f.FileId,
              name: f.FileName,
              sizeBytes: f.Size,
            })),
          })),
          feedback: feedback
            ? {
                score: feedback.Score,
                comment: toText(feedback.Feedback),
                isGraded: feedback.IsGraded,
              }
            : null,
        });
      }),
  );

  server.registerTool(
    'download_submission_file',
    {
      title: 'Download a file from one of my submissions',
      description:
        'Downloads a file the user already submitted to an assignment, using the ' +
        'submissionId and fileId from list_my_submissions, and saves it to disk.',
      inputSchema: {
        course: courseRef,
        assignmentId: z.number().describe('Assignment id from list_assignments.'),
        submissionId: z
          .number()
          .describe('Submission id from list_my_submissions.'),
        fileId: z.number().describe('File id from list_my_submissions.'),
      },
    },
    async ({ course, assignmentId, submissionId, fileId }) =>
      guard(async () => {
        const orgUnitId = await resolveOrgUnitId(client, course);
        const path = await client.le(
          `/${orgUnitId}/dropbox/folders/${assignmentId}/submissions/${submissionId}/files/${fileId}`,
        );
        const { data, filename, contentType } = await client.getBuffer(path);

        const name = filename ?? `submission-${submissionId}-file-${fileId}`;
        const dir = join(downloadDir(), String(orgUnitId), 'submissions');
        await mkdir(dir, { recursive: true });
        const savedTo = join(dir, name);
        await writeFile(savedTo, data);

        return ok({
          courseId: orgUnitId,
          assignmentId,
          submissionId,
          fileId,
          filename: name,
          contentType,
          sizeBytes: data.byteLength,
          savedTo,
        });
      }),
  );

  server.registerTool(
    'submit_assignment',
    {
      title: 'Submit an assignment (requires confirmation)',
      description:
        'Uploads one or more local files to a myCourses assignment folder. ' +
        'Submitting cannot be undone, so this tool is two-step: call it WITHOUT ' +
        'confirmToken to get a preview of exactly what would be sent, show that ' +
        'preview to the user, and only call again with the returned confirmToken ' +
        'once they have said yes.',
      inputSchema: {
        course: courseRef,
        assignmentId: z.number().describe('Assignment id from list_assignments.'),
        filePaths: z
          .array(z.string())
          .min(1)
          .describe('Absolute paths to the local files to upload.'),
        comment: z
          .string()
          .optional()
          .describe('Optional comment to attach to the submission.'),
        confirmToken: z
          .string()
          .optional()
          .describe(
            'Omit on the first call. Pass the token from the preview to actually submit.',
          ),
      },
    },
    async ({ course, assignmentId, filePaths, comment, confirmToken }) =>
      guard(async () => {
        if (confirmToken) {
          return ok(await consume('submit_assignment', confirmToken));
        }

        const orgUnitId = await resolveOrgUnitId(client, course);
        const folder = await fetchFolder(client, orgUnitId, assignmentId);
        assertSubmittable(folder);

        const parts: UploadPart[] = [];
        const fileSummaries: Record<string, unknown>[] = [];

        for (const raw of filePaths) {
          const path = resolve(raw);
          const info = await stat(path).catch(() => null);
          if (!info?.isFile()) {
            throw new Error(`Not a readable file: ${path}`);
          }
          const data = await readFile(path);
          const filename = basename(path);
          parts.push({ filename, contentType: guessMimeType(filename), data });
          fileSummaries.push({
            path,
            filename,
            sizeBytes: data.byteLength,
            sha256: createHash('sha256').update(data).digest('hex').slice(0, 16),
          });
        }

        const metadata = {
          Text: comment ?? '',
          Html: comment ? `<p>${comment}</p>` : '',
        };
        const submitPath = await client.le(
          `/${orgUnitId}/dropbox/folders/${assignmentId}/submissions/mysubmissions/`,
        );

        const existing = await client
          .get<DropboxSubmission[]>(submitPath, { cacheSeconds: 0 })
          .then((envelopes) => envelopes.flatMap((e) => e.Submissions))
          .catch(() => []);

        return ok(
          stage(
            'submit_assignment',
            {
              course: { courseId: orgUnitId },
              assignment: {
                assignmentId,
                name: folder.Name,
                dueDate: formatDate(folder.DueDate),
                due: relativeTo(folder.DueDate),
                wouldBeLate: folder.DueDate
                  ? new Date(folder.DueDate).getTime() < Date.now()
                  : false,
                submissionType:
                  folder.SubmissionType != null
                    ? SubmissionType[folder.SubmissionType]
                    : 'unspecified',
              },
              files: fileSummaries,
              comment: comment ?? null,
              existingSubmissions: existing.length,
              warning:
                existing.length > 0
                  ? `You already have ${existing.length} submission(s) here. This adds another.`
                  : null,
            },
            async () => {
              const result = await client.postMultipart(submitPath, metadata, parts);
              return {
                status: 'submitted',
                assignmentId,
                courseId: orgUnitId,
                assignmentName: folder.Name,
                filesUploaded: fileSummaries.map((f) => f.filename),
                submittedAt: new Date().toISOString(),
                response: result,
              };
            },
          ),
        );
      }),
  );
}
