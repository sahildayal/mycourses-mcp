import { mkdir } from 'node:fs/promises';
import type { BrowserContext } from 'playwright-core';
import { browserProfile } from '../config.js';

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
}

export interface SessionData {
  host: string;
  cookies: StoredCookie[];
  xsrfToken: string;
  savedAt: string;
}

/** Cookies Brightspace actually uses to identify the session. */
const SESSION_COOKIES = ['d2lSessionVal', 'd2lSecureSessionVal'];

async function harvest(
  context: BrowserContext,
  host: string,
): Promise<SessionData | null> {
  const cookies = await context.cookies(`https://${host}/`);
  const hasSession = cookies.some(
    (c) => c.name === 'd2lSessionVal' && c.value.length > 0,
  );
  if (!hasSession) return null;

  const page = context.pages()[0];
  if (!page) return null;

  // The key is normally `XSRF.Token`, but D2L has shuffled it before. Scan
  // rather than hard-code so a rename doesn't silently break every write.
  const xsrfToken = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && /xsrf/i.test(key)) {
        const value = localStorage.getItem(key);
        if (value) return value;
      }
    }
    return null;
  });

  if (!xsrfToken) return null;

  return {
    host,
    cookies: cookies
      .filter((c) => SESSION_COOKIES.includes(c.name) || c.name.startsWith('d2l'))
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
      })),
    xsrfToken,
    savedAt: new Date().toISOString(),
  };
}

/**
 * Browser channels to try, in order. Driving an already-installed Chrome or
 * Edge means `npx mycourses-mcp` needs no 190 MB browser download — which
 * matters a lot when the whole pitch is one-command setup. Falls back to a
 * Playwright-managed build for anyone who has run `playwright install`.
 */
const BROWSER_CHANNELS = ['chrome', 'msedge', 'chromium'];

async function openContext(headless: boolean): Promise<BrowserContext> {
  const { chromium } = await import('playwright-core');
  const profile = browserProfile();
  await mkdir(profile, { recursive: true });

  const options = { headless, viewport: { width: 1280, height: 900 } };
  const channels = process.env.MYCOURSES_BROWSER
    ? [process.env.MYCOURSES_BROWSER]
    : BROWSER_CHANNELS;

  const failures: string[] = [];
  for (const channel of channels) {
    try {
      return await chromium.launchPersistentContext(profile, { ...options, channel });
    } catch (error) {
      failures.push(`${channel}: ${(error as Error).message.split('\n')[0]}`);
    }
  }

  // Last resort: whatever Playwright has downloaded locally, if anything.
  try {
    return await chromium.launchPersistentContext(profile, options);
  } catch (error) {
    failures.push(`bundled: ${(error as Error).message.split('\n')[0]}`);
  }

  throw new Error(
    'Could not launch a browser to sign in with. Install Google Chrome or ' +
      'Microsoft Edge, or run `npx playwright install chromium`. Set ' +
      'MYCOURSES_BROWSER to force a channel (chrome, msedge, chromium).\n\n' +
      `Tried:\n  ${failures.join('\n  ')}`,
  );
}

/**
 * Opens a real browser window and waits for the user to complete RIT's
 * Shibboleth sign-in and Duo prompt themselves. No password ever passes
 * through this process.
 */
export async function interactiveLogin(
  host: string,
  timeoutMs = 5 * 60_000,
  log: (msg: string) => void = console.error,
): Promise<SessionData> {
  const context = await openContext(false);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`https://${host}/d2l/home`, { waitUntil: 'domcontentloaded' });

    log('');
    log('  A browser window is open. Sign in to myCourses with your RIT');
    log('  account and approve the Duo prompt. This window will close by');
    log('  itself once the session is captured.');
    log('');

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = await harvest(context, host);
      if (session) {
        log('  Session captured.');
        return session;
      }
      await page.waitForTimeout(1500);
    }
    throw new Error(
      `Timed out after ${Math.round(timeoutMs / 60_000)} minutes waiting for sign-in.`,
    );
  } finally {
    await context.close();
  }
}

/**
 * Re-derive a session without user interaction. Works when RIT's IdP still has
 * a live SSO session, in which case Brightspace hands back a new session cookie
 * with no Duo prompt. Returns null if it can't get there silently.
 */
export async function silentRefresh(
  host: string,
  timeoutMs = 45_000,
): Promise<SessionData | null> {
  let context: BrowserContext | undefined;
  try {
    context = await openContext(true);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`https://${host}/d2l/home`, {
      waitUntil: 'networkidle',
      timeout: timeoutMs,
    });
    return await harvest(context, host);
  } catch {
    return null;
  } finally {
    await context?.close().catch(() => {});
  }
}
