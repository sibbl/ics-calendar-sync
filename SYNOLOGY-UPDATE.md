# Update an existing Synology deployment

Use this procedure for an already configured service. Release publication and the reviewed immutable image reference must be confirmed before downloading. Do not use an older private package's moving tag as the release reference. The published image supports linux/amd64 and linux/arm64; confirm your NAS architecture before updating.

1. Record the existing image digest, Compose files and container UID/GID. Privately back up the existing ENV configuration, isolated OAuth directory, input files and any pending/archive directories. Preserve source UUIDs, target selections, rules, paths and credentials exactly. A changed UUID changes event ownership. Keep the Mac/other writer stopped throughout.
2. Stop the existing NAS service before replacing it. Save a temporary preview configuration with `ENABLE_GOOGLE_WRITES=false` and all sources `enabled=false`; disabling writes alone still permits scheduled reads. Retain the original configuration privately for rollback. Do not create a second running copy.
3. Download the Compose files and documentation from the exact reviewed release commit. Preserve the existing private port binding, host paths and UID/GID. Create a local image override with the reviewed reference:

   ```yaml
   services:
     calendar-sync:
       image: ghcr.io/<approved-owner>/<approved-repository>@sha256:<reviewed-digest>
   ```

   Include it last in the existing Compose selection. Pull that exact image, then recreate using `docker compose up -d --no-build` (or the corresponding Container Manager update). Do not build a local image accidentally. Check the resulting image digest and platform.
4. Default folder aggregation and keep need no new writable mount. For snapshot confirmation/resume or archive/delete, create a separate private state directory, mode 0700, owned by the existing container UID/GID. Set `DATA_STATE_DIR` to that directory and add `compose.data.yaml`; it mounts `/data` separately from `/auth`. Never reuse OAuth or input directories as `/data`.
5. Open the UI privately and preview each existing source with writes disabled. Verify anonymous times, recurrence warnings, counts, source/target selections and filter behavior. For a weekly replacement, explicitly choose folder snapshot, its fixed basename, and unknown/full/window authority. Confirm actual exporter completeness; window end is exclusive and timezone is explicit. Recurring/window-crossing absences are protected. Every new byte revision requires another confirmed preview, and an empty export requires a separate confirmation. A missing file does not mean an empty export.
6. Leave file handling at keep unless the exporter publishes complete files atomically and never modifies published files in place. Only after that contract and backups are established, choose archive or delete, check the producer confirmation and add `compose.consume.yaml` together with the data overlay. This explicitly makes the source mount writable. Failed/partial imports retain files; unresolved claims require review. Delete removes confirmed input claims, not imported calendar events.
7. Privately export only the edited source configuration into the existing ENV, preserving credentials and UUIDs. When the previews and snapshot authority are accepted, restore the intentionally chosen write setting and scheduler selections for this single NAS service. Snapshot confirmation is performed manually with its preview; subsequent approved retries can resume from `/data`. Check count-only completion and the next scheduled run.

For rollback, stop the updated service first and restore the previous exact image and backed-up configuration/mount selection. Retain current inputs, `/data` and pending/archive directories privately; do not discard them or assume restoring configuration reverses Google writes or recovers deleted input files. Inspect them before choosing which backup to restore. Never restart the Mac as a second writer.

Google sources use interval/cron polling. Near-real-time push would still fetch changes and requires a trusted reachable HTTPS callback, channel renewal and reconciliation; this release registers no watch channels and opens no public callback.
