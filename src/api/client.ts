import { HOST, versionOverrides } from '../config.js';
import { AuthError, type AuthProvider } from '../auth/provider.js';
import { buildMultipartMixed, type UploadPart } from './multipart.js';
import type { ProductVersions } from './types.js';

export class D2LApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'D2LApiError';
  }
}

/** Simple token bucket. Brightspace is not generous with burst traffic. */
class RateLimiter {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly capacity = 8,
    private readonly refillPerSecond = 4,
  ) {
    this.tokens = capacity;
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(
        this.capacity,
        this.tokens + ((now - this.last) / 1000) * this.refillPerSecond,
      );
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = ((1 - this.tokens) / this.refillPerSecond) * 1000;
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
    }
  }
}

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

export interface GetOptions {
  /** Cache lifetime in seconds. 0 disables caching for this call. */
  cacheSeconds?: number;
  query?: Record<string, string | number | boolean | undefined>;
}

export class D2LClient {
  private readonly limiter = new RateLimiter();
  private readonly cache = new Map<string, CacheEntry>();
  private versions: Map<string, string> | null = null;

  constructor(
    private readonly auth: AuthProvider,
    readonly host: string = HOST,
  ) {
    if (/^https?:\/\//i.test(host)) {
      throw new Error('host must be a bare hostname, e.g. mycourses.rit.edu');
    }
  }

  private url(path: string, query?: GetOptions['query']): string {
    const url = new URL(`https://${this.host}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Brightspace versions its API per product component and bumps them on each
   * release, so resolve them at runtime rather than pinning and breaking.
   */
  async apiVersions(): Promise<Map<string, string>> {
    if (this.versions) return this.versions;

    const response = await fetch(this.url('/d2l/api/versions/'), {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new D2LApiError(
        `Could not read API versions from ${this.host}`,
        response.status,
        await response.text().catch(() => ''),
        '/d2l/api/versions/',
      );
    }
    const products = (await response.json()) as ProductVersions[];
    this.versions = new Map(
      products.map((p) => [
        p.ProductCode,
        versionOverrides[p.ProductCode] ?? p.LatestVersion,
      ]),
    );
    return this.versions;
  }

  private async versionFor(product: 'lp' | 'le'): Promise<string> {
    const version = (await this.apiVersions()).get(product);
    if (!version) {
      throw new Error(`${this.host} does not expose the "${product}" API component.`);
    }
    return version;
  }

  /** Build a Learning Platform route, e.g. lp('/users/whoami'). */
  async lp(path: string): Promise<string> {
    return `/d2l/api/lp/${await this.versionFor('lp')}${path}`;
  }

  /** Build a Learning Environment route, e.g. le('/12345/grades/values/myGradeValues/'). */
  async le(path: string): Promise<string> {
    return `/d2l/api/le/${await this.versionFor('le')}${path}`;
  }

  private async request(
    method: string,
    path: string,
    init: { body?: string | Buffer; contentType?: string; query?: GetOptions['query'] },
    isRetry = false,
  ): Promise<Response> {
    await this.limiter.take();

    const mutating = method !== 'GET' && method !== 'HEAD';
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(await this.auth.getHeaders(mutating)),
    };
    if (init.contentType) headers['Content-Type'] = init.contentType;

    const response = await fetch(this.url(path, init.query), {
      method,
      headers,
      body: init.body,
      redirect: 'manual',
    });

    // A 302 to the login page is Brightspace's way of saying "session gone".
    const expired = response.status === 401 || response.status === 302;
    if (expired && !isRetry) {
      if (await this.auth.refresh()) {
        return this.request(method, path, init, true);
      }
      throw new AuthError(
        'myCourses session has expired. Run `mycourses-mcp login` to sign in again.',
      );
    }
    if (expired) {
      throw new AuthError(
        'myCourses rejected the session even after refreshing. Run `mycourses-mcp login`.',
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new D2LApiError(
        `${method} ${path} failed with HTTP ${response.status}`,
        response.status,
        body.slice(0, 2000),
        path,
      );
    }
    return response;
  }

  async get<T>(path: string, options: GetOptions = {}): Promise<T> {
    const cacheKey = `${path}?${JSON.stringify(options.query ?? {})}`;
    const ttl = options.cacheSeconds ?? 0;

    if (ttl > 0) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    }

    const response = await this.request('GET', path, { query: options.query });
    const value = (await response.json()) as T;

    if (ttl > 0) {
      this.cache.set(cacheKey, { expiresAt: Date.now() + ttl * 1000, value });
    }
    return value;
  }

  async getBuffer(
    path: string,
    query?: GetOptions['query'],
  ): Promise<{ data: Buffer; filename: string | null; contentType: string | null }> {
    const response = await this.request('GET', path, { query });
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    return {
      data: Buffer.from(await response.arrayBuffer()),
      filename: match?.[1] ? decodeURIComponent(match[1]) : null,
      contentType: response.headers.get('content-type'),
    };
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request('POST', path, {
      body: JSON.stringify(body),
      contentType: 'application/json',
    });
    this.cache.clear();
    return (await this.parse<T>(response)) as T;
  }

  async postMultipart<T>(
    path: string,
    metadata: unknown,
    files: UploadPart[],
  ): Promise<T> {
    const { body, contentType } = buildMultipartMixed(metadata, files);
    const response = await this.request('POST', path, { body, contentType });
    this.cache.clear();
    return (await this.parse<T>(response)) as T;
  }

  /** Some write routes answer 200 with an empty body. */
  private async parse<T>(response: Response): Promise<T | null> {
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  /**
   * Walk a bookmark-paged route to completion. Handles both response shapes
   * Brightspace uses (`Items` on lp routes, `Objects` on le routes).
   */
  async getAllPages<T>(
    path: string,
    options: GetOptions = {},
    maxPages = 25,
  ): Promise<T[]> {
    const results: T[] = [];
    let bookmark: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const body = await this.get<{
        PagingInfo?: { Bookmark: string | null; HasMoreItems: boolean };
        Items?: T[];
        Objects?: T[];
      }>(path, { ...options, query: { ...options.query, bookmark } });

      results.push(...(body.Items ?? body.Objects ?? []));

      if (!body.PagingInfo?.HasMoreItems || !body.PagingInfo.Bookmark) break;
      bookmark = body.PagingInfo.Bookmark;
    }
    return results;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
