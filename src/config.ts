import { homedir } from 'node:os';
import { join } from 'node:path';

/** Brightspace host. RIT's myCourses unless overridden. */
export const HOST = process.env.MYCOURSES_HOST ?? 'mycourses.rit.edu';

export type AuthKind = 'session' | 'oauth';

export const AUTH_KIND: AuthKind =
  process.env.MYCOURSES_AUTH === 'oauth' ? 'oauth' : 'session';

/**
 * Per-user state directory, outside the repo. Credentials never live in the
 * project tree, so a stray `git add -A` can't leak them.
 */
export function dataDir(): string {
  const base =
    process.env.APPDATA ??
    (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : join(homedir(), '.config'));
  return join(base, 'mycourses-mcp');
}

export const sessionFile = () => join(dataDir(), 'session.enc');
export const keyFile = () => join(dataDir(), 'key');
export const browserProfile = () => join(dataDir(), 'browser-profile');
export const downloadDir = () =>
  process.env.MYCOURSES_DOWNLOAD_DIR ?? join(dataDir(), 'downloads');

/** Explicit version pins, e.g. MYCOURSES_LP_VERSION=1.56. Rarely needed. */
export const versionOverrides: Record<string, string | undefined> = {
  lp: process.env.MYCOURSES_LP_VERSION,
  le: process.env.MYCOURSES_LE_VERSION,
};
