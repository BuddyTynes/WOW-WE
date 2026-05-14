$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$backupDir = Join-Path $root "backups"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $backupDir "wow-live-db-$stamp.sql.gz"

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

docker exec -e MYSQL_PWD=acore ac-database sh -c `
    'mysqldump -uroot --databases acore_auth acore_characters acore_world acore_playerbots --single-transaction --routines --events --triggers --hex-blob --default-character-set=utf8mb4 | gzip -c > /tmp/wow-live-db.sql.gz'
docker cp ac-database:/tmp/wow-live-db.sql.gz $out
docker exec ac-database rm -f /tmp/wow-live-db.sql.gz

Write-Host "Wrote $out"
