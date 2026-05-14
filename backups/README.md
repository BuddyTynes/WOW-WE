# Live Database Snapshot

This folder contains the shared testing database snapshot:

```text
wow-live-db.sql.gz
```

To restore the snapshot into the local Docker MySQL container:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-live-db.ps1
```

The restore script copies `backups\wow-live-db.sql.gz` into `ac-database`,
imports it with MySQL, then removes the temporary dump from the container.
