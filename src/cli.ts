#!/usr/bin/env node
import { D2LClient } from './api/client.js';
import { interactiveLogin } from './auth/login.js';
import { SessionAuthProvider } from './auth/session.js';
import { clearSecret } from './auth/store.js';
import { AUTH_KIND, dataDir, HOST } from './config.js';
import type { WhoAmI } from './api/types.js';

const log = console.error;

async function cmdLogin(): Promise<void> {
  log(`Signing in to ${HOST} …`);
  const provider = new SessionAuthProvider(HOST);
  const session = await interactiveLogin(HOST);
  await provider.adopt(session);

  const client = new D2LClient(provider, HOST);
  const me = await client.get<WhoAmI>(await client.lp('/users/whoami'));
  log('');
  log(`  Signed in as ${me.FirstName} ${me.LastName} (${me.UniqueName})`);
  log(`  Session stored in ${dataDir()}`);
  log('');
}

async function cmdStatus(): Promise<void> {
  const provider = new SessionAuthProvider(HOST);
  const status = await provider.describe();
  log(`host          ${status.host}`);
  log(`provider      ${status.kind}`);
  log(`authenticated ${status.authenticated}`);
  if (status.savedAt) log(`captured      ${status.savedAt} (${status.ageHours} h ago)`);
  log(`detail        ${status.detail}`);

  if (!status.authenticated) process.exitCode = 1;
}

async function cmdDoctor(): Promise<void> {
  log(`host        ${HOST}`);
  log(`auth mode   ${AUTH_KIND}`);
  log(`data dir    ${dataDir()}`);
  log('');

  const provider = new SessionAuthProvider(HOST);
  const client = new D2LClient(provider, HOST);

  try {
    const versions = await client.apiVersions();
    log(`API reachable. lp=${versions.get('lp')} le=${versions.get('le')}`);
  } catch (error) {
    log(`Could not reach the Brightspace API: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const status = await provider.describe();
  if (!status.authenticated) {
    log('No stored session. Run `mycourses-mcp login`.');
    process.exitCode = 1;
    return;
  }

  try {
    const me = await client.get<WhoAmI>(await client.lp('/users/whoami'));
    log(`Session works. Signed in as ${me.FirstName} ${me.LastName}.`);
  } catch (error) {
    log(`Session did not work: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

async function cmdLogout(): Promise<void> {
  await clearSecret();
  log('Stored session cleared.');
  log(`Browser profile is still in ${dataDir()}; delete it to sign out fully.`);
}

const USAGE = `mycourses-mcp <command>

  (no command)  Start the MCP server on stdio — this is what an MCP client runs
  serve         Same as above, stated explicitly
  login         Open a browser, sign in, and store the session
  status        Show whether a usable session is stored
  doctor        Check API reachability and verify the stored session works
  logout        Delete the stored session

Set MYCOURSES_HOST for a school other than RIT, e.g.
  MYCOURSES_HOST=brightspace.example.edu mycourses-mcp login
`;

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case 'login':
      return cmdLogin();
    case 'status':
      return cmdStatus();
    case 'doctor':
      return cmdDoctor();
    case 'logout':
      return cmdLogout();
    case '--help':
    case '-h':
    case 'help':
      log(USAGE);
      return;
    case undefined:
    case 'serve': {
      // No command means "be an MCP server", so a client can just run
      // `npx -y mycourses-mcp` with no arguments.
      const { startServer } = await import('./index.js');
      return startServer();
    }
    default:
      log(`Unknown command: ${command}\n`);
      log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  log(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
