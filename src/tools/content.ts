import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { D2LClient } from '../api/client.js';
import type { ContentModule, ContentObject, ContentTopic } from '../api/types.js';
import { downloadDir } from '../config.js';
import { resolveOrgUnitId } from './courses.js';
import { formatDate, guard, ok, stripHtml, toText } from './shared.js';

const courseRef = z
  .union([z.string(), z.number()])
  .describe('Course id from list_courses, or part of the course name/code.');

/** Structure entries are modules (Type 0) or topics (Type 1). */
function isModule(item: ContentObject): item is ContentModule {
  return item.Type === 0;
}

function summarizeItem(item: ContentObject) {
  if (isModule(item)) {
    return {
      kind: 'module' as const,
      moduleId: item.Id,
      title: item.Title,
      dueDate: formatDate(item.ModuleDueDate),
      isHidden: item.IsHidden,
    };
  }
  const topic = item as ContentTopic;
  return {
    kind: 'topic' as const,
    topicId: topic.Id,
    title: topic.Title,
    url: topic.Url ?? null,
    dueDate: formatDate(topic.DueDate),
    isHidden: topic.IsHidden,
    downloadable: Boolean(topic.Url),
  };
}

async function extractText(
  data: Buffer,
  filename: string,
): Promise<{ text: string | null; extractor: string }> {
  const lower = filename.toLowerCase();
  try {
    if (lower.endsWith('.pdf')) {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data });
      try {
        const result = await parser.getText();
        return { text: result.text, extractor: 'pdf-parse' };
      } finally {
        await parser.destroy();
      }
    }
    if (lower.endsWith('.docx')) {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer: data });
      return { text: result.value, extractor: 'mammoth' };
    }
    if (/\.(txt|md|csv|json|html?|js|ts|py|java|c|cpp|h)$/.test(lower)) {
      const text = data.toString('utf8');
      return {
        text: lower.endsWith('.html') || lower.endsWith('.htm') ? stripHtml(text) : text,
        extractor: 'utf8',
      };
    }
  } catch (error) {
    return {
      text: null,
      extractor: `failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { text: null, extractor: 'unsupported' };
}

export function register(server: McpServer, client: D2LClient): void {
  server.registerTool(
    'list_modules',
    {
      title: 'List course content modules',
      description:
        'Lists the top-level content modules (the left-hand nav of a course), ' +
        'giving moduleIds to drill into with get_module.',
      inputSchema: { course: courseRef },
    },
    async ({ course }) =>
      guard(async () => {
        const orgUnitId = await resolveOrgUnitId(client, course);
        const path = await client.le(`/${orgUnitId}/content/root/`);
        const modules = await client.get<ContentObject[]>(path, { cacheSeconds: 900 });
        return ok({
          courseId: orgUnitId,
          count: modules.length,
          modules: modules.filter((m) => !m.IsHidden).map(summarizeItem),
        });
      }),
  );

  server.registerTool(
    'get_module',
    {
      title: 'Get a content module',
      description:
        'Returns the child modules and topics inside a module, plus its description.',
      inputSchema: {
        course: courseRef,
        moduleId: z.number().describe('Module id from list_modules.'),
      },
    },
    async ({ course, moduleId }) =>
      guard(async () => {
        const orgUnitId = await resolveOrgUnitId(client, course);
        const path = await client.le(
          `/${orgUnitId}/content/modules/${moduleId}/structure/`,
        );
        const children = await client.get<ContentObject[]>(path, { cacheSeconds: 900 });
        return ok({
          courseId: orgUnitId,
          moduleId,
          count: children.length,
          items: children.filter((c) => !c.IsHidden).map(summarizeItem),
        });
      }),
  );

  server.registerTool(
    'get_topic',
    {
      title: 'Get a content topic',
      description:
        'Metadata for a single content topic — title, dates, description and the ' +
        'underlying file path if it has one.',
      inputSchema: {
        course: courseRef,
        topicId: z.number().describe('Topic id from get_module or list_modules.'),
      },
    },
    async ({ course, topicId }) =>
      guard(async () => {
        const orgUnitId = await resolveOrgUnitId(client, course);
        const path = await client.le(`/${orgUnitId}/content/topics/${topicId}`);
        const topic = await client.get<ContentTopic>(path, { cacheSeconds: 900 });
        return ok({
          courseId: orgUnitId,
          topicId: topic.Id,
          title: topic.Title,
          url: topic.Url ?? null,
          startDate: formatDate(topic.StartDate),
          dueDate: formatDate(topic.DueDate),
          endDate: formatDate(topic.EndDate),
          description: toText(topic.Description),
        });
      }),
  );

  server.registerTool(
    'download_topic_file',
    {
      title: 'Download a course file and read its text',
      description:
        'Downloads the file behind a content topic (lecture slides, PDFs, notes) ' +
        'and extracts its text so it can be read directly. PDFs and .docx are ' +
        'parsed; other types are saved to disk and reported by path.',
      inputSchema: {
        course: courseRef,
        topicId: z.number().describe('Topic id from get_module.'),
        extractText: z
          .boolean()
          .optional()
          .describe('Extract text content. Default true.'),
        maxChars: z
          .number()
          .min(500)
          .max(200_000)
          .optional()
          .describe('Truncate extracted text at this length. Default 20000.'),
      },
    },
    async ({ course, topicId, extractText: wantText, maxChars }) =>
      guard(async () => {
        const orgUnitId = await resolveOrgUnitId(client, course);
        const path = await client.le(
          `/${orgUnitId}/content/topics/${topicId}/file`,
        );
        const { data, filename, contentType } = await client.getBuffer(path);

        const name = filename ?? `topic-${topicId}`;
        const dir = join(downloadDir(), String(orgUnitId));
        await mkdir(dir, { recursive: true });
        const savedTo = join(dir, name);
        await writeFile(savedTo, data);

        const result: Record<string, unknown> = {
          courseId: orgUnitId,
          topicId,
          filename: name,
          contentType,
          sizeBytes: data.byteLength,
          savedTo,
        };

        if (wantText !== false) {
          const { text, extractor } = await extractText(data, name);
          result.extractor = extractor;
          if (text) {
            const limit = maxChars ?? 20_000;
            result.text = text.length > limit ? `${text.slice(0, limit)}\n\n…[truncated]` : text;
            result.truncated = text.length > limit;
            result.fullLength = text.length;
          } else {
            result.text = null;
            result.note = `No text extracted (${extractor}). The file is saved at savedTo.`;
          }
        }

        return ok(result);
      }),
  );
}
