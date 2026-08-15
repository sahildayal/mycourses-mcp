import { AuthError, type AuthProvider, type AuthStatus } from './provider.js';
import { loadSecret, saveSecret } from './store.js';

const TOKEN_URL = 'https://auth.brightspace.com/core/connect/token';
export const AUTH_URL = 'https://auth.brightspace.com/oauth2/auth';

/**
 * Every scope this server's tools need, in the order they'd be requested on an
 * app registration form. Hand this list to RIT ITS verbatim if they agree to
 * register a client.
 */
export const REQUIRED_SCOPES = [
  'core:*:*',
  'enrollment:own_enrollment:read',
  'grades:own_grades:read',
  'content:modules:readonly',
  'content:topics:readonly',
  'content:file:read',
  'dropbox:folders:read',
  'dropbox:folders:write',
  'discussions:forums:readonly',
  'discussions:topics:readonly',
  'discussions:posts:readonly',
  'discussions:posts:manage',
  'calendar:my_events:read',
  'news:announcements:read',
].join(' ');

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * Standard OAuth 2.0 bearer auth. Inert until a Brightspace administrator
 * registers a client and MYCOURSES_CLIENT_ID / _SECRET are set — at which
 * point set MYCOURSES_AUTH=oauth and nothing else in the server changes.
 */
export class OAuthProvider implements AuthProvider {
  readonly kind = 'oauth' as const;

  private tokens: TokenSet | null = null;

  constructor(
    private readonly host: string,
    private readonly clientId = process.env.MYCOURSES_CLIENT_ID,
    private readonly clientSecret = process.env.MYCOURSES_CLIENT_SECRET,
  ) {}

  private async tokenSet(): Promise<TokenSet> {
    this.tokens ??= await loadSecret<TokenSet>();
    if (!this.tokens) {
      throw new AuthError(
        'No OAuth tokens stored. Complete the authorization-code flow first, ' +
          'or set MYCOURSES_AUTH=session to use browser-session auth instead.',
      );
    }
    if (Date.now() >= this.tokens.expiresAt - 60_000) {
      if (!(await this.refresh())) {
        throw new AuthError('OAuth token expired and refresh failed. Re-authorize.');
      }
    }
    return this.tokens;
  }

  async getHeaders(_mutating: boolean): Promise<Record<string, string>> {
    const { accessToken } = await this.tokenSet();
    return { Authorization: `Bearer ${accessToken}` };
  }

  async refresh(): Promise<boolean> {
    const current = this.tokens ?? (await loadSecret<TokenSet>());
    if (!current?.refreshToken || !this.clientId || !this.clientSecret) return false;

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!response.ok) return false;

    const body = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    this.tokens = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    await saveSecret(this.tokens);
    return true;
  }

  async describe(): Promise<AuthStatus> {
    const tokens = this.tokens ?? (await loadSecret<TokenSet>());
    return {
      kind: 'oauth',
      authenticated: Boolean(tokens && Date.now() < tokens.expiresAt),
      host: this.host,
      detail: tokens
        ? `Access token expires ${new Date(tokens.expiresAt).toISOString()}`
        : 'No OAuth tokens stored.',
    };
  }
}
