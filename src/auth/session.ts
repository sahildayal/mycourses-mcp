import { HOST } from '../config.js';
import { silentRefresh, type SessionData } from './login.js';
import { AuthError, NOT_LOGGED_IN, type AuthProvider, type AuthStatus } from './provider.js';
import { loadSecret, saveSecret } from './store.js';

/**
 * Authenticates the way Brightspace's own web UI does: the session cookie
 * identifies you, and an XSRF token from localStorage authorises writes.
 * D2L requires that header on every non-GET made under session auth.
 */
export class SessionAuthProvider implements AuthProvider {
  readonly kind = 'session' as const;

  private cached: SessionData | null = null;
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly host: string = HOST) {}

  private async session(): Promise<SessionData> {
    if (!this.cached) {
      this.cached = await loadSecret<SessionData>();
    }
    if (!this.cached) throw new AuthError(NOT_LOGGED_IN);
    return this.cached;
  }

  async getHeaders(mutating: boolean): Promise<Record<string, string>> {
    const session = await this.session();
    const cookie = session.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    const headers: Record<string, string> = { Cookie: cookie };
    if (mutating) headers['X-Csrf-Token'] = session.xsrfToken;
    return headers;
  }

  /** Collapses concurrent 401s into a single refresh attempt. */
  async refresh(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const session = await silentRefresh(this.host);
    if (!session) return false;
    this.cached = session;
    await saveSecret(session);
    return true;
  }

  /** Called by the login CLI once a fresh session has been captured. */
  async adopt(session: SessionData): Promise<void> {
    this.cached = session;
    await saveSecret(session);
  }

  async describe(): Promise<AuthStatus> {
    const session = this.cached ?? (await loadSecret<SessionData>());
    if (!session) {
      return {
        kind: 'session',
        authenticated: false,
        host: this.host,
        detail: NOT_LOGGED_IN,
      };
    }
    const ageHours =
      (Date.now() - new Date(session.savedAt).getTime()) / 3_600_000;
    return {
      kind: 'session',
      authenticated: true,
      host: this.host,
      savedAt: session.savedAt,
      ageHours: Math.round(ageHours * 10) / 10,
      detail:
        ageHours > 24
          ? 'Session is over a day old and has probably expired; a silent refresh will be attempted on first use.'
          : 'Session looks current.',
    };
  }
}
