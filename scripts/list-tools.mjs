#!/usr/bin/env node
// Starts the MCP server over stdio and prints its tool surface.
// Useful as a smoke test after changing tool registrations — it needs no
// myCourses session, since listing tools does not touch the network.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Optional entry override, so both server entry points can be smoke-tested:
//   node scripts/list-tools.mjs            -> dist/index.js
//   node scripts/list-tools.mjs dist/cli.js -> the bin, with no arguments
const entry = process.argv[2] ?? join(root, 'dist', 'index.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
});

const client = new Client({ name: 'list-tools', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
tools.sort((a, b) => a.name.localeCompare(b.name));

for (const tool of tools) {
  const params = Object.keys(tool.inputSchema?.properties ?? {});
  console.log(`${tool.name}(${params.join(', ')})`);
}
console.log(`\n${tools.length} tools`);

await client.close();
