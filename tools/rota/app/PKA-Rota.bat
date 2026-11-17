@echo off
setlocal
cd /d "%~dp0"

rem ELECTRON_RUN_AS_NODE=1 no ambiente faz o electron.exe rodar como Node puro,
rem sem janela e sem `require('electron')`. Isso veio de outro processo (o T3
rem Code usa essa variavel). Sem limpar, o app morre com "Cannot find module
rem 'electron'" — foi exatamente o que aconteceu no primeiro lancamento.
set ELECTRON_RUN_AS_NODE=
set ELECTRON_NO_ASAR=

if not exist "electron\electron.exe" (
  echo [ERRO] electron\electron.exe nao encontrado.
  echo Rode: node tools\build_rota_app.cjs
  pause
  exit /b 1
)

"electron\electron.exe" "app" %*
if errorlevel 1 pause
endlocal
