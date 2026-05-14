# Live Database Snapshot

This folder contains the shared testing database snapshot as split gzip chunks:

```text
wow-live-db.sql.gz.part001
wow-live-db.sql.gz.part002
...
```

The chunks are split because GitHub rejects individual files over 100 MB.

To restore the snapshot into the local Docker MySQL container:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-live-db.ps1
```

The restore script reassembles `backups\wow-live-db.sql.gz`, copies it into
`ac-database`, imports it with MySQL, then removes the temporary combined dump
from the container.
