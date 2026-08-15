#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { D2LClient } from './api/client.js';
import { OAuthProvider } from './auth/oauth.js';
import type { AuthProvider } from './auth/provider.js';
import { SessionAuthProvider } from './auth/session.js';
import { AUTH_KIND, HOST } from './config.js';
import * as announcements from './tools/announcements.js';
import * as assignments from './tools/assignments.js';
import * as calendar from './tools/calendar.js';
import * as content from './tools/content.js';
import * as courses from './tools/courses.js';
import * as discussions from './tools/discussions.js';
import * as grades from './tools/grades.js';

export function createServer(): { server: McpServer; client: D2LClient } {
  const auth: AuthProvider =
    AUTH_KIND === 'oauth' ? new OAuthProvider(HOST) : new SessionAuthProvider(HOST);
  const client = new D2LClient(auth, HOST);

  const server = new McpServer({
    name: 'mycourses-mcp',
    version: '0.1.0',
  });

  courses.register(server, client, auth);
  assignments.register(server, client);
  grades.register(server, client);
  calendar.register(server, client);
  announcements.register(server, client);
  content.register(server, client);
  discussions.register(server, client);

  return { server, client };
}

export async function startServer(): Promise<void> {
  const { server } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout belongs to the protocol; anything human-readable goes to stderr.
  console.error(`mycourses-mcp ready (host=${HOST}, auth=${AUTH_KIND})`);
}

/**
 * Only self-start when run directly (`node dist/index.js`). The CLI imports
 * this module to serve `mycourses-mcp` with no arguments, and must not trigger
 * a second server.
 */
const isEntryPoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  startServer().catch((error) => {
    console.error('mycourses-mcp failed to start:', error);
    process.exit(1);
  });
}
