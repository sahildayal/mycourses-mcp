# Contributing

Thanks for taking a look. This project is small and the setup is short, but
Brightspace is quirky in ways that are worth knowing before you start.

## Getting set up

```bash
pnpm install
pnpm build
node dist/cli.js login     # opens a browser; you sign in yourself
node dist/cli.js doctor    # confirms the session works
```

Sign-in drives an already-installed Chrome or Edge via `playwright-core`, so
there is no browser download. If you have neither, `npx playwright install
chromium` gives you one; `MYCOURSES_BROWSER` forces a specific channel.

Set `MYCOURSES_HOST` to your own school's Brightspace hostname if it isn't
RIT's. If you're unsure whether your instance exposes the API at all, open
`https://YOUR-HOST/d2l/api/versions/` in a browser — it needs no login, and a
JSON list of product codes means you're good.

Your session is encrypted into your OS user profile, never into the repo.
`login` drives a real browser so **you** enter your password and complete MFA;
no credential ever passes through this code. Please keep it that way.

## Testing your change

CI runs `pnpm typecheck`, `pnpm build`, and a smoke test that boots the server
and lists its tools. That's all it *can* do — CI has no Brightspace session, so
it proves your code compiles and registers, never that it works.

Real verification is manual, against your own account:

```bash
node scripts/verify.mjs              # read path + a submit dry run
node scripts/verify-content.mjs      # proves a dry run writes nothing; file extraction
node scripts/verify-discussions.mjs  # discussion reads, withheld-post handling, reply dry run
```

These discover courses from whatever account is signed in, so they work for
anyone. Say in your PR which school you tested against — a fix that works at
one school can fail at another.

`scripts/diag.mjs` and `scripts/analyze-terms.mjs` are for poking at raw API
responses when you're figuring out a shape.

## Adding a tool

Tools live in `src/tools/`, one module per subject area, each exporting
`register(server, client)`. Copy the shape of an existing one:

- Wrap the handler in `guard()` from `tools/shared.ts` so errors come back as
  readable text instead of a stack trace.
- Take a `course` parameter as `z.union([z.string(), z.number()])` and resolve
  it with `resolveOrgUnitId()`, so callers can pass a name fragment.
- Return through `ok()`.
- Use `client.lp()` / `client.le()` to build routes. Never hardcode an API
  version — they're discovered at runtime and differ between schools.
- Pass `cacheSeconds` for reads. Writes bypass and clear the cache.

Register the module in `src/index.ts`.

## The rule about writes

Submitting an assignment and posting to a discussion cannot be undone. Every
write tool is therefore two-phase, and new ones must be too:

1. Called **without** a `confirmToken`, the tool performs **no** network write.
   It returns a preview of exactly what would be sent, plus a single-use token.
2. Only a second call carrying that token performs the action.

Use `stage()` and `consume()` from `src/confirm.ts` — don't roll your own. A PR
that makes a write path fire on the first call won't be merged, however
convenient it is.

Quizzes and exams are out of scope on purpose and won't be added.

## Style

- TypeScript strict mode; no `any` without a comment explaining why.
- Comment the surprises, not the syntax. Brightspace has many surprises —
  `IsActive` meaning "not archived", the author field being
  `PostingUserDisplayName`, `mysubmissions` returning envelopes rather than
  submissions. If you lose an hour to one, leave a note so the next person
  doesn't.
- Match the surrounding code.

## Reporting Brightspace differences

The most useful contributions are often not code. If a tool misbehaves at your
school, open an issue with your host, your `lp`/`le` versions, and what came
back. Differences between instances are the hardest thing to find alone.

## Security

Don't paste cookies, session values, or CSRF tokens into issues or PRs. If you
find a vulnerability, please report it privately through GitHub's security
advisories rather than opening a public issue.
