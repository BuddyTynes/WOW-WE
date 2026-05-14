$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$backupDir = Join-Path $root "backups"
$combined = Join-Path $backupDir "wow-live-db.sql.gz"

if (-not (Test-Path -LiteralPath $combined)) {
    throw "No dump found at $combined"
}

Write-Host "Copying dump into ac-database..."
docker cp $combined ac-database:/tmp/wow-live-db.sql.gz

Write-Host "Importing live snapshot. This replaces tables included in the dump."
docker exec -e MYSQL_PWD=acore ac-database sh -c 'gunzip -c /tmp/wow-live-db.sql.gz | mysql -uroot'

Write-Host "Cleaning temporary dump from container..."
docker exec ac-database rm -f /tmp/wow-live-db.sql.gz

Write-Host "Restore complete."
