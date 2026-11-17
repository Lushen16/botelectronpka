$root = 'C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial'
$log = Join-Path $root 'tap-inject.log'
'ini ' + (Get-Date -Format o) | Out-File -LiteralPath $log -Encoding utf8
& (Join-Path $root 'native\pka_inject.exe') --pid 572 --dll (Join-Path $root 'native\pka_tap.dll') *>> $log
'fim ' + (Get-Date -Format o) | Out-File -LiteralPath $log -Append -Encoding utf8
