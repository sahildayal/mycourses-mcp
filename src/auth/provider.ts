export interface AuthStatus {
  kind: string;
  authenticated: boolean;
  host: string;
  detail: string;
  savedAt?: string;
  ageHours?: number;
}

/**
 * The single seam between the tools and however we happen to be authenticating.
 * `D2LClient` knows nothing else about auth, so moving from a scraped browser
 * session to real OAuth credentials is a config change, not a rewrite.
 */
export interface AuthProvider {
  readonly kind: 'session' | 'oauth';

  /**
   * Headers to attach to a request. `mutating` is true for anything that isn't
   * a GET — session auth must add the XSRF header there or Brightspace 403s.
   */
  getHeaders(mutating: boolean): Promise<Record<string, string>>;

  /** Called once after a 401. Return true if a retry is worth attempting. */
  refresh(): Promise<boolean>;

  describe(): Promise<AuthStatus>;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export const NOT_LOGGED_IN =
  'Not authenticated to myCourses. Run `mycourses-mcp login` in a terminal, ' +
  'complete the RIT sign-in and Duo prompt in the browser window that opens, ' +
  'then retry.';
