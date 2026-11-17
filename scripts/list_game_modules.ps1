$proc = Get-Process -Name PokeAlliance_dx -ErrorAction SilentlyContinue
if ($null -ne $proc) {
    Write-Output "PID: $($proc.Id)"
    foreach ($m in $proc.Modules) {
        $name = $m.FileName
        if ($name -notmatch "Windows\\System32" -and $name -notmatch "Windows\\SysWOW64" -and $name -notmatch "Windows\\WinSxS") {
            Write-Output "MODULE: $name"
        }
    }
} else {
    Write-Output "PokeAlliance_dx not running"
}
