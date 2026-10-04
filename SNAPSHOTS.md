# Weekly replacement snapshots and file handling

Defaults remain folder aggregation and keep. A folder snapshot reads exactly the configured basename (for example `weekly.ics`); other direct ICS files are not merged. No newest-file/mtime guessing. Replace the published file atomically, then preview the new version.

## Explicit authority

Unknown scope never infers missing-event cancellation. Full scope means the owner confirms the export covers the entire logical source. Window scope requires configured start date, exclusive end date and IANA timezone. A local calendar week uses local midnight to the following week's midnight, including DST; bounds are never inferred from event minimum/maximum or assumed Outlook metadata.

Preview reports new, changed, unchanged and proposed missing-event cancellations. Only owned target records qualify. Window cancellations are limited to single events fully contained in the window; recurring masters, instances and crossing-boundary records are protected. Explicit UID cancellations remain supported. Recurrence-structure/master-time changes, including changed EXDATE rules, still stop for reviewed migration; bounded Outlook exports must not silently rewrite a series. Real exporter compatibility must be checked with a private actual export.

Every new snapshot byte revision/configuration requires a preview and explicit Synchronisieren confirmation. Empty exports additionally require explicit completeness confirmation. Missing files are not empty snapshots. Invalid/truncated exports fail closed. Proposed cancellations are bound to observed target ETags; target changes require a fresh preview. Confirmation is persisted under /data so approved partial runs can resume after restart, using actual target comparison rather than replaying successful writes.

## Optional protected state

Use compose.data.yaml and an existing private host directory via DATA_STATE_DIR, mounted writable at /data. Set the correct host/container UID/GID (the existing auth overlay does this). Directory mode 0700; atomic versioned state files mode 0600. DATA_DIR must be separate from inputs and OAuth storage. Auth remains in its existing isolated /auth mount. No database or persistent full calendar copy is required. Per-source state stores content/configuration fingerprints, approved removal IDs/ETags, empty-export confirmation and cleanup identity/progress. Back up data privately with matching configuration; never commit or include it in builds. Restoring state with changed input/configuration does not authorize that new snapshot. Invalid versions/files fail closed.

Example private deployment selection:

```dotenv
COMPOSE_FILE=compose.yaml:compose.auth.yaml:compose.data.yaml
DATA_STATE_DIR=/approved/private/path/data
```

Paths and UID/GID are operator-selected, not inferred. Keep the existing service single-writer; do not add a separate scheduler.

## Keep, archive or delete

Keep performs no file cleanup and retains the default read-only input mount. Archive/delete are explicit per-folder choices and require a writable input mount (compose.consume.yaml), /data, and confirmation that the producer publishes completed files atomically and never modifies published files in place. If that producer contract is not established, keep is the supported choice. Stabilization/hashes alone cannot prove another process has closed an open writable handle.

Cleanup happens only after all planned target operations are acknowledged. Failures/quota pauses retain input. Each exact imported inode/size/timestamps/hash is checked, journaled, renamed into a protected same-filesystem claim and checked again. A racing replacement is retained/restored without overwriting a newer producer file. Configuration changes revoke cleanup permission. Archive keeps verified bytes in `.ics-sync-archive/<source-id>/`; delete removes only a verified claim. `.ics-sync-pending/<source-id>/` retains interrupted/racing claims. These directories are private and excluded from direct-file discovery. Cleanup does not cancel imported events. An empty consumed inbox waits for the next export.

Journal recovery finishes already-confirmed claims; it never authorizes cleanup of changed bytes. Retained claims require operator review; do not purge unknown files or manually edit approval state to bypass a safety stop. Publish another complete replacement and preview it, or temporarily choose keep while resolving a retained claim. Back up the inbox, pending/archive directories and /data before deployment changes or destructive cleanup choices. State records are bounded; unresolved claims must be reviewed rather than growing indefinitely.

Source options are exported in SOURCES_JSON: folderMode, snapshotFile, snapshotScope, fileHandling and immutableFilesConfirmed. UI edits remain ephemeral until privately saving ENV configuration. The journal is not a substitute for keeping source IDs/rules/target configuration stable.
