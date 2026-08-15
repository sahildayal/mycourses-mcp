import { randomBytes } from 'node:crypto';

const TTL_MS = 5 * 60_000;

interface Staged {
  kind: string;
  summary: Record<string, unknown>;
  createdAt: number;
  execute: () => Promise<unknown>;
}

const staged = new Map<string, Staged>();

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [token, entry] of staged) {
    if (entry.createdAt < cutoff) staged.delete(token);
  }
}

export interface StagedPreview {
  status: 'confirmation_required';
  action: string;
  willDo: Record<string, unknown>;
  confirmToken: string;
  expiresAt: string;
  note: string;
}

/**
 * Stage an irreversible action instead of performing it. Nothing is sent to
 * Brightspace until `consume` is called with the returned token — a submitted
 * assignment or a posted discussion reply cannot be quietly taken back, so the
 * caller has to look at the preview and ask again.
 */
export function stage(
  kind: string,
  summary: Record<string, unknown>,
  execute: () => Promise<unknown>,
): StagedPreview {
  sweep();
  const confirmToken = randomBytes(9).toString('base64url');
  staged.set(confirmToken, { kind, summary, createdAt: Date.now(), execute });

  return {
    status: 'confirmation_required',
    action: kind,
    willDo: summary,
    confirmToken,
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
    note:
      'Nothing has been sent to myCourses yet. Show this plan to the user and ' +
      'get their go-ahead, then call the same tool again with this confirmToken ' +
      'to actually perform it. The token works once and expires in 5 minutes.',
  };
}

export class ConfirmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmError';
  }
}

/** Redeem a token exactly once. */
export async function consume(kind: string, token: string): Promise<unknown> {
  sweep();
  const entry = staged.get(token);
  if (!entry) {
    throw new ConfirmError(
      'That confirmToken is unknown or expired. Call the tool again without a ' +
        'confirmToken to get a fresh preview.',
    );
  }
  if (entry.kind !== kind) {
    throw new ConfirmError(
      `That confirmToken was issued for "${entry.kind}", not "${kind}".`,
    );
  }
  staged.delete(token);
  return entry.execute();
}
