@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo === PKA Tools - Limpar perfil do Electron ===
echo.
echo Isto apaga SOMENTE o cache do Chromium usado pela interface:
echo   local-data\electron
echo.
echo Perfis, rotas (.lua), configuracoes e dados locais NAO sao tocados.
echo.
echo Use quando a interface falhar com 0x80000003 sem explicacao.
echo.
set /p CONF="Continuar (s/N)? "
if /i not "%CONF%"=="s" (
  echo Cancelado.
  exit /b 0
)

rem Electron aberto segura os arquivos e a limpeza falha silenciosamente.
rem Encerrar apenas os processos cujo caminho esta DENTRO deste projeto.
echo.
echo [i] Encerrando Electron desta pasta, se houver...
powershell -NoProfile -Command ^
  "$root = (Resolve-Path '.').Path; Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root) } | ForEach-Object { Write-Host ('    encerrando pid ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

timeout /t 2 /nobreak >nul

for %%D in ("local-data\electron" "smoke-data\electron" "audit-data\electron") do (
  if exist "%%~D" (
    echo [i] Removendo %%~D
    rmdir /s /q "%%~D" 2>nul
    if exist "%%~D" (
      echo     [!] Nao foi possivel remover tudo. Feche a interface e tente de novo.
    ) else (
      echo     ok
    )
  )
)

echo.
echo Pronto. Abra com ABRIR_RECONSTRUCAO.bat
echo.
pause >nul
exit /b 0
