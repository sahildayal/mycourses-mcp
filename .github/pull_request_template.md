## What this changes

<!-- One or two sentences. Link an issue if there is one. -->

## How it was tested

<!--
Which school/host did you test against, and which tools did you exercise?
"Ran scripts/verify.mjs against <school>" is a great answer.
CI only proves it compiles and registers — it cannot reach a real Brightspace.
-->

- [ ] `pnpm build` and `pnpm typecheck` pass
- [ ] Tested against a real Brightspace instance (say which, below)

## If this touches a write tool

Assignment submissions and discussion posts are irreversible, so every write
path stays two-phase: no `confirmToken` means preview only, no network write.

- [ ] Calling without `confirmToken` still performs **no** write
- [ ] The preview shows the user everything that would be sent
- [ ] Tokens remain single-use and time-limited
- [ ] Not applicable — this PR does not touch a write path

## Anything reviewers should know

<!-- Brightspace quirks, version differences between schools, follow-up work. -->
