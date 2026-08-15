# mycourses-mcp

An MCP server for D2L Brightspace that can **read and write** — check what's
due, read course material, submit assignments, and post to discussions without
opening the website.

Built for RIT's myCourses, but nothing in the code is RIT-specific: point
`MYCOURSES_HOST` at any Brightspace instance.

Every other D2L MCP server is read-only. This one submits.

## Scope, and what it deliberately won't do

This automates the **transport** of your own coursework — moving a file you
wrote into a dropbox, posting text you wrote into a thread. It does not write
anything for you.

**Quizzes and exams are not implemented and will not be.** No tool in this
project can open, read, answer, or submit an assessment. That's a deliberate
line, not an oversight, and feature requests to cross it will be declined.

Writes are irreversible, so they're gated: the first call only ever returns a
preview of what *would* be sent. See [the confirmation gate](#the-confirmation-gate).

Check your institution's acceptable-use policy before pointing this at your
account. It uses your own credentials to reach your own data, but "allowed" is
your school's call, not this README's.

## Tools

| Area | Tools |
|---|---|
| Session | `auth_status`, `whoami` |
| Courses | `list_courses` |
| Assignments | `list_assignments`, `get_assignment`, `list_my_submissions`, `download_submission_file`, `submit_assignment` ⚠️ |
| Grades | `get_grades`, `get_final_grade` |
| Deadlines | `get_upcoming_deadlines` |
| Content | `list_modules`, `get_module`, `get_topic`, `download_topic_file` |
| Discussions | `list_forums`, `list_topics`, `read_posts`, `create_discussion_post` ⚠️, `reply_to_post` ⚠️ |
| Announcements | `get_announcements` |

⚠️ = irreversible, behind a confirmation step.

Most tools take a course **name fragment** instead of an id — `"Data
Structures"` works as well as `1234567`. Since course names repeat across
years, resolution checks the current term first and only widens if nothing
recent matches.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
pnpm build

node dist/cli.js login     # opens a browser; you sign in and clear MFA yourself
node dist/cli.js doctor    # confirms the session works
```

Register with Claude Code:

```bash
claude mcp add mycourses -- node /absolute/path/to/mycourses-mcp/dist/index.js
```

Not at RIT? Set `MYCOURSES_HOST` to your school's Brightspace hostname. To
check your instance exposes the API, open `https://YOUR-HOST/d2l/api/versions/`
in a browser — no login needed, and a JSON list of product codes means yes.

## How authentication works

Brightspace's own web UI authenticates its API calls with a session cookie plus
an `X-Csrf-Token` header from `localStorage`. This server does the same thing.

`login` opens a real browser and waits while **you** complete your school's
sign-in and MFA. The resulting session is encrypted (AES-256-GCM) into your OS
user profile — `%APPDATA%/mycourses-mcp/` on Windows. No password passes
through this code, and no credential is ever written into the repo.

Sessions last roughly a day. On expiry the server tries a silent headless
refresh first, which usually succeeds while your SSO session is alive and
needs no MFA prompt; only if that fails does it ask you to re-run `login`.

### Why not official OAuth?

Because Brightspace OAuth clients can only be registered by an administrator,
under *Admin Tools → Manage Extensibility*. There's no self-service signup, so
a student can't get credentials without their institution issuing them.

The code is ready if that changes. `src/auth/oauth.ts` implements the
bearer-token provider and `REQUIRED_SCOPES` lists every scope these tools need
— useful if you're asking your IT department. Then:

```
MYCOURSES_AUTH=oauth
MYCOURSES_CLIENT_ID=...
MYCOURSES_CLIENT_SECRET=...
```

Nothing else changes: tools only talk to `D2LClient`, which only talks to an
`AuthProvider`.

## The confirmation gate

Submitting an assignment or posting to a discussion cannot be undone, so those
three tools are two-step. Called without a `confirmToken` they perform **no**
network write — they return a preview:

```jsonc
{
  "status": "confirmation_required",
  "willDo": {
    "assignment": { "name": "Project 3", "dueDate": "…", "wouldBeLate": false },
    "files": [{ "filename": "project3.pdf", "sizeBytes": 208412, "sha256": "9f2c…" }],
    "existingSubmissions": 0
  },
  "confirmToken": "kR3v…",
  "expiresAt": "…"
}
```

Only a second call carrying that token performs the action. Tokens are
single-use and expire after five minutes. The point is that an assistant
cannot submit your half-finished essay because it misread you — you see the
filename, the size, the hash, and whether it'd be late, before anything moves.

## Which courses show up

`list_courses` defaults to `scope: "current"` — what you're taking now, courses
starting soon, and a three-week grace after a term ends so final grades stay
reachable. `"recent"` widens to ~4 months; `"all"` is everything.

This matters more than it sounds. Brightspace's `IsActive` flag does **not**
mean "this term" — it means "not archived", and returns `true` for courses from
years ago. Filtering on it returned 60 courses going back to 2021 in testing.
The scopes filter on end date instead, with a `lastAccessed` fallback for
courses that have no end date and would otherwise never age out.

Each course carries a `status` (`in_session`, `upcoming`, `not_yet_open`,
`recently_ended`) and an `isAssisting` flag separating courses you TA from ones
you take. Unpublished courses are listed rather than hidden — seeing next term
appear is the point — but flagged, since most tools 403 until they open.

## Term-change watcher

`scripts/fall-check.mjs` checks that a new term has appeared and the tools work
against it, then writes a dated report to `reports/`. It remembers which course
ids it has seen, so it can tell a new term from a quiet day.

Exit codes: `0` nothing new, `1` needs attention, `2` new courses appeared.

`scripts/run-term-check.ps1` wraps it for a Windows Scheduled Task and only
raises a popup on `1` or `2`:

```powershell
$repo = 'C:\path\to\mycourses-mcp'
$tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$repo\scripts\run-term-check.ps1`""
schtasks /Create /TN "myCourses Term Check" /TR $tr /SC DAILY /ST 09:07 /SD 08/17/2026 /ED 09/01/2026 /RU $env:USERNAME /IT /F
```

Remove with `schtasks /Delete /TN "myCourses Term Check" /F`.

## Configuration

Copy `.env.example`. Everything defaults sensibly for RIT; the knobs most
people touch are `MYCOURSES_HOST` and `MYCOURSES_DOWNLOAD_DIR`.

## Layout

```
src/
  api/       D2LClient (version discovery, rate limiting, caching), multipart, types
  auth/      AuthProvider interface, session + oauth providers, browser login, crypto store
  tools/     one module per subject area, each exporting register(server, client)
  confirm.ts two-phase confirmation for irreversible actions
scripts/
  list-tools.mjs          smoke test: boots the server, prints the tool surface
  verify.mjs              read path end to end + a submit dry run
  verify-content.mjs      proves a dry run wrote nothing; file download and extraction
  verify-discussions.mjs  discussion reads, withheld posts, reply dry run
  analyze-terms.mjs       enrolment shape: end dates, staleness, scope tuning
  fall-check.mjs          term-change watcher
  run-term-check.ps1      Scheduled Task wrapper for the watcher
  diag.mjs                ad-hoc API poking against a live host
reports/                  watcher output; gitignored
```

The verify scripts discover courses from whoever is signed in, so they work on
any account without editing.

## Known limits

- **Text-entry assignments** can't be submitted — Brightspace's submission
  route requires a file. File and file-or-text assignments work.
- **Group assignments** use a different route that isn't wired up yet.
- **Some courses 403 on `list_my_submissions`.** This is per-course and
  sometimes per-assignment, and appears to be an instructor-side permission
  rather than a bug. No API workaround exists; use the web UI's *View history*.
- API versions are discovered at runtime from `/d2l/api/versions/`, so D2L's
  version bumps don't break anything. RIT is on lp 1.62 / le 1.96 as of writing.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Reports of how this behaves at other
schools are especially useful — Brightspace instances differ in ways that are
hard to discover alone.

## License

MIT — see [LICENSE](LICENSE).
