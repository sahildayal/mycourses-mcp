import { randomBytes } from 'node:crypto';

export interface UploadPart {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartBody {
  body: Buffer;
  contentType: string;
}

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;

/**
 * RFC 2046 multipart/mixed, the shape Brightspace wants for dropbox
 * submissions and discussion attachments: a JSON metadata part first, then one
 * part per file. Note the odd `name=""` in the file part — that is what D2L's
 * documented examples use, and their parser expects it.
 */
export function buildMultipartMixed(
  metadata: unknown,
  files: UploadPart[],
): MultipartBody {
  const boundary = `----mycoursesmcp${randomBytes(16).toString('hex')}`;
  const chunks: Buffer[] = [];

  chunks.push(
    Buffer.from(
      `--${boundary}${CRLF}Content-Type: application/json${CRLF}${CRLF}` +
        `${JSON.stringify(metadata)}${CRLF}`,
      'utf8',
    ),
  );

  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name=""; filename="${sanitize(file.filename)}"${CRLF}` +
          `Content-Type: ${file.contentType}${CRLF}${CRLF}`,
        'utf8',
      ),
    );
    chunks.push(file.data);
    chunks.push(Buffer.from(CRLF, 'utf8'));
  }

  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/mixed; boundary=${boundary}`,
  };
}

/**
 * Quotes, backslashes and control characters would break the
 * Content-Disposition header, so replace them. Spaces are fine and common in
 * real coursework filenames, so they are left alone.
 */
function sanitize(filename: string): string {
  let out = '';
  for (const ch of filename) {
    const code = ch.charCodeAt(0);
    out += ch === '"' || ch === '\\' || code < 32 || code === 127 ? '_' : ch;
  }
  return out;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  rtf: 'application/rtf',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  py: 'text/x-python',
  java: 'text/x-java-source',
  c: 'text/x-c',
  cpp: 'text/x-c',
  h: 'text/x-c',
  js: 'text/javascript',
  ts: 'text/plain',
  html: 'text/html',
  ipynb: 'application/json',
};

export function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
