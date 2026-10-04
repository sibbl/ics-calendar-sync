# ICS → Google Calendar sync

TypeScript service with a minimal React UI. Import upload, file, folder, URL or Google calendar sources into individually selected writable Google calendars. Configure anonymization, busy filters, location opt-in and ordered regex transformations per source. Configuration is ENV-first; no database is required.

Recurring events, all-day dates, timezones and explicit exceptions retain their semantics. Stable IDs, ownership checks, bounded reads and cycle guards protect existing events. Actual target comparison skips unchanged events and detects missing copies/manual drift. Google incremental cursors and operational progress are memory-only; restart reconstructs them from complete reads. OAuth token rotation can persist in a protected auth file.

## Setup

Node 24 is tested. Copy `.env.example` to a private `.env` and supply the admin token, sources and intended calendar settings. Keep writes disabled until previews are reviewed. Never commit credentials or real ICS files.

```sh
npm ci
npm run build
```

Compose binds the UI to `127.0.0.1:8080` and mounts `./ics` read-only at `/sources`. Create the input directory before starting. For protected file-based OAuth, use `compose.auth.yaml` together with the base file, create the auth directory/file with modes 0700/0600 and set APP_UID/APP_GID to its host owner. Set `COMPOSE_FILE=compose.yaml:compose.auth.yaml` in private deployment configuration. OAuth ENV fields must not be mixed with AUTH_FILE. OAuth setup uses an interactive private terminal: `npm run oauth:setup -- --with-calendar-list`. Existing private OAuth ENV credentials can be migrated with `npm run auth:migrate -- --from-env-file <private-input> --output-file <private-auth-file>`; neither command is part of ordinary CI.

```sh
docker compose config --quiet
docker compose build calendar-sync
# Starting a configured service runs its enabled automatic sources immediately:
docker compose up -d --no-deps calendar-sync
```

UI edits/uploads are ephemeral; export configuration and privately persist it for redeployments. Native `npm start` requires environment variables; Node does not automatically load `.env`.

## Reliability and deployment

One serial queue paces Calendar requests and writes. Eligible quota failures stop the run, wait at least ten minutes plus jitter, progressively increase recovery delay and pause automatic recovery after six failures. Longer Retry-After is honored. Permanent malformed/permission errors do not automatically retry. Ambiguous writes are reconciled before resend. Interval schedules start after completion; cron skips missed occurrences; folder-watch notifications coalesce. Logs expose counts and sanitized reasons, not calendar contents or credentials.

Deploy with absolute input/auth bind paths and the correct host UID/GID. Build for the target architecture; do not copy host node_modules. Keep the UI private. Only one host may run enabled calendar writes: verify a destination in preview-only mode, stop the old writer, hand off current auth/input state securely, then activate the new writer. Stop the new writer before rollback. Input mounts do not transport future files; arrange an approved complete-file delivery workflow separately. No public push callback is configured; polling/cron does not guarantee zero latency.

## Verification

```sh
npm run typecheck
npm run test:report
npm run build
npm run e2e
```

Tests use synthetic fixtures and block external calendar requests. Playwright starts an isolated writes-forbidden fixture server on port 18082; Chromium must be installed separately. Reports are local and ignored. The current suite contains 278 Vitest tests and 11 Chromium checks.

## Container registry

GitHub Actions checks code/tests/UI, then publishes `ghcr.io/<owner>/<repository>` on main pushes, tags and manual runs. Pull requests build without publishing. Publishing uses only the job-scoped GITHUB_TOKEN; no personal credential is stored. Actions are pinned to commits. Multi-platform output targets Linux amd64/arm64; the NAS architecture must still be discovered and verified.

`main` and `latest` follow successful main builds; Git tags retain their names. Every build also receives `sha-<full-commit>`, OCI revision/source labels and a digest recorded in its job summary. For deployments, prefer `ghcr.io/<owner>/<repository>@sha256:<verified-digest>` rather than a moving tag. Keep release artifacts private until their exact layers, configuration and remaining attestations pass privacy review. Public images can then be pulled without a registry credential; if an image is private, registry access requires separately owner-approved setup. Do not create or deploy a PAT automatically. This workflow never deploys to a host or enables calendar writes.

Release privacy: BuildKit provenance and automatic build-record uploads are disabled because GitHub push-event metadata can include personal email addresses. Publishing invokes Buildx directly with an isolated environment and prints only the verified image digest, because action metadata logging can expose the same event payload even when attestations are disabled. SBOM output remains enabled and must be reviewed together with exact image layers/config and full CI logs before public publication. A clean source commit alone does not clear older image attestations.

## Weekly exports

Optional folder replacement snapshots and keep/archive/delete handling are described in [SNAPSHOTS.md](SNAPSHOTS.md). Scope is explicit; missing/outside-window events are protected unless a reviewed authoritative snapshot permits cancellation. New revisions require confirmed previews, with protected /data approval/cleanup state. Default aggregation/keep/read-only behavior is unchanged. No cleanup mode is enabled by the image or deployment workflow.

For an existing deployment, follow [SYNOLOGY-UPDATE.md](SYNOLOGY-UPDATE.md) using the exact reviewed release image.
