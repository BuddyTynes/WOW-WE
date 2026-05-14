$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$backupDir = Join-Path $root "backups"
$combined = Join-Path $backupDir "wow-live-db.sql.gz"
$parts = Get-ChildItem -LiteralPath $backupDir -Filter "wow-live-db.sql.gz.part*" | Sort-Object Name

if ($parts.Count -eq 0) {
    throw "No dump chunks found in $backupDir"
}

Write-Host "Reassembling $($parts.Count) dump chunks..."
if (Test-Path -LiteralPath $combined) {
    Remove-Item -LiteralPath $combined -Force
}

$output = [IO.File]::Create($combined)
try {
    foreach ($part in $parts) {
        Write-Host "Adding $($part.Name)"
        $input = [IO.File]::OpenRead($part.FullName)
        try {
            $input.CopyTo($output)
        }
        finally {
            $input.Dispose()
        }
    }
}
finally {
    $output.Dispose()
}

Write-Host "Copying dump into ac-database..."
docker cp $combined ac-database:/tmp/wow-live-db.sql.gz

Write-Host "Importing live snapshot. This replaces tables included in the dump."
docker exec -e MYSQL_PWD=acore ac-database sh -c 'gunzip -c /tmp/wow-live-db.sql.gz | mysql -uroot'

Write-Host "Cleaning temporary dump from container..."
docker exec ac-database rm -f /tmp/wow-live-db.sql.gz

Write-Host "Restore complete."
