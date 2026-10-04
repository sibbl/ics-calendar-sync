# Repository instructions

- Implement TypeScript changes in server/, shared/ and src/. Keep the minimal UI and ENV-first/no-database design.
- Never commit or print .env, OAuth/admin credentials, auth-store contents, real ICS files, calendar identities or private event data. Use synthetic fixtures. Local reports and migration evidence stay ignored.
- Preserve user configuration/auth/input files. Do not start, restart or stop an existing deployment, invoke a live sync, enable writes/schedulers, transfer credentials or change remote networking without task authorization. A service start immediately runs enabled sources.
- Keep OAuth persistence in its protected isolated auth mount; operational cursors/caches/retry hints remain runtime-only. Preserve token rotation, modes and locking semantics.
- Retain stable IDs, ownership/ETag checks, recurrence/all-day/timezone/exception behavior, bounded complete reads, deletion safety and copy-loop guards. Never infer deletion from incomplete/quarantined input. Desired hashes are hints, not substitutes for comparing actual targets.
- Keep one serialized scheduler/request queue, paced requests, bounded progressive quota recovery and count-only safe logs. No immediate replay of uncertain writes, overlap/catch-up storms or quota-bypass restarts.
- Keep scripts/patch-re2.cjs and pinned dependency lockfile in builds. Deploy with read-only source/root mounts and only the auth directory writable; use correct host UID/GID and a private UI binding.
- Before migration activation, verify preview-only destination and stop the previous writer. Never operate two writers. Credential handoff requires its separately authorized secure workflow.
- Run npm run typecheck, npm test and npm run build for implementation changes; run npm run e2e for UI behavior. Existing tests use synthetic data and block external requests. Do not run production probes as tests. Documentation-only changes need factual/link review rather than new mirror tests.
- Use concise documentation describing supported behavior; do not publish personal deployment paths, host addresses or historical operational evidence.
