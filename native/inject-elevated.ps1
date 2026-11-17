# Injeta pka_native.dll no cliente ja aberto (precisa de elevacao) e grava log.
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'inject-elevated.log'
& (Join-Path $PSScriptRoot 'pka_inject.exe') --pid $args[0] --dll (Join-Path $PSScriptRoot 'pka_native.dll') *> $log
"exit=$LASTEXITCODE" | Add-Content $log
