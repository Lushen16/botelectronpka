$root = "C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial"
$pidGame = 37936
$playerName = "Nobutdopai"

Write-Host "[+] Iniciando Scanners de Telemetria e Coletor de 40 Minutos..." -ForegroundColor Green

# 1. Matar qualquer scanner anterior
Get-Process | Where-Object { $_.CommandLine -match "hunt_session_collector|pka_live_session|scan_creatures" } | Stop-Process -Force -ErrorAction SilentlyContinue

# 2. Iniciar pka_live_session
$pkaProc = Start-Process -FilePath "python" -ArgumentList "$root\tools\pka_live_session.py --pid $pidGame --watch --output `"$root\live-snapshot.json`" --interval-ms 500" -WorkingDirectory $root -WindowStyle Hidden -PassThru

# 3. Iniciar scan_creatures
$scanProc = Start-Process -FilePath "python" -ArgumentList "$root\tools\scan_creatures.py --pid $pidGame --player-name $playerName --stream --interval-ms 500 --output `"$root\live-creatures.json`"" -WorkingDirectory $root -WindowStyle Hidden -PassThru

# 4. Iniciar hunt_session_collector
$collectorProc = Start-Process -FilePath "python" -ArgumentList "$root\tools\hunt_session_collector.py" -WorkingDirectory $root -WindowStyle Hidden -PassThru

Start-Sleep -Seconds 3

Write-Host "[+] Processos iniciados:" -ForegroundColor Cyan
Write-Host "    - pka_live_session PID: $($pkaProc.Id)"
Write-Host "    - scan_creatures PID: $($scanProc.Id)"
Write-Host "    - hunt_session_collector PID: $($collectorProc.Id)"

# Verificar se os JSONs estao sendo gerados
if (Test-Path "$root\live-snapshot.json") {
    Write-Host "[+] live-snapshot.json ATIVO e atualizado!" -ForegroundColor Green
}
if (Test-Path "$root\hunt_session_summary.json") {
    Write-Host "[+] hunt_session_summary.json ATIVO!" -ForegroundColor Green
}
