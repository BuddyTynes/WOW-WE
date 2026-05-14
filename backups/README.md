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

After restoring, verify `acore_auth.realmlist`. The snapshot may contain the
realm address for the shared server, which is not always correct for local
Docker testing:

```powershell
docker exec -e MYSQL_PWD=acore ac-database mysql -uroot -e "SELECT id, name, address, localAddress, localSubnetMask, port FROM acore_auth.realmlist;"
```

Local test clients should use `127.0.0.1:8085`:

```powershell
docker exec -e MYSQL_PWD=acore ac-database mysql -uroot -e "UPDATE acore_auth.realmlist SET address='127.0.0.1', localAddress='127.0.0.1', localSubnetMask='255.255.255.0', port=8085 WHERE id=1;"
docker compose restart ac-authserver
```

The shared server should use its reachable server address instead, currently
`38.190.118.191:8085`. If the address is wrong, clients can authenticate and
see the realm or character count, but selecting the realm may kick them back to
server select.
