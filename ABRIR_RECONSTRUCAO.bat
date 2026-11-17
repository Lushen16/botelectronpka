@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo === PKA Tools - Reconstrucao local ===
echo.

rem ---------------------------------------------------------------------------
rem ELECTRON_RUN_AS_NODE=1 transforma o electron.exe em Node puro: ele nao abre
rem janela e morre com "Cannot find module 'electron'". A variavel e' herdada
rem de ferramentas que embutem o Electron (T3 Code, Codex, VS Code). Limpar
rem aqui e' obrigatorio — nao basta o usuario "nao ter setado".
rem ---------------------------------------------------------------------------
if defined ELECTRON_RUN_AS_NODE (
  echo [i] ELECTRON_RUN_AS_NODE=%ELECTRON_RUN_AS_NODE% detectado; limpando.
)
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ASAR="

rem Flags que estabilizam o Chromium em maquinas com driver de video antigo,
rem VM ou sessao remota. So' entram se o usuario pedir (PKA_SAFE_GPU=1), para
rem nao mascarar aceleracao real em quem tem GPU boa.
if "%PKA_SAFE_GPU%"=="1" (
  echo [i] Modo GPU seguro ativado.
  set "PKA_EXTRA_FLAGS=--disable-gpu --disable-gpu-compositing --disable-software-rasterizer --in-process-gpu"
)

if not exist "%~dp0runtime\electron-v44.7.2\electron.exe" (
  echo [ERRO] runtime\electron-v44.7.2\electron.exe nao encontrado.
  echo        O runtime do Electron nao esta nesta copia do projeto.
  goto failed
)
if not exist "%~dp0reconstruction\app\main.cjs" (
  echo [ERRO] reconstruction\app\main.cjs nao encontrado.
  echo        Rode este .bat na raiz do projeto.
  goto failed
)

rem ---------------------------------------------------------------------------
rem Sessao 0 = servico sem desktop. Nenhuma janela pode aparecer ali, e o
rem Chromium aborta com 0x80000003. Detectar antes evita um erro confuso.
rem ---------------------------------------------------------------------------
for /f "tokens=3" %%S in ('tasklist /fi "imagename eq explorer.exe" /fo table /nh 2^>nul ^| findstr /i explorer') do set "SHELL_SESSION=%%S"
if not defined SHELL_SESSION (
  echo [!] Aviso: nao encontrei explorer.exe. Se voce esta em sessao de servico
  echo     ou SSH sem desktop, a janela nao abre. Rode numa sessao com area de trabalho.
  echo.
)

echo [i] Abrindo a interface...
echo.

set "PKA_LOG=%TEMP%\pka-app-launch.log"
"%~dp0runtime\electron-v44.7.2\electron.exe" "%~dp0reconstruction\app" %PKA_EXTRA_FLAGS% --enable-logging=stderr 2>"%PKA_LOG%"
set "RC=%ERRORLEVEL%"

if "%RC%"=="0" (
  echo.
  echo Interface encerrada normalmente.
  exit /b 0
)

echo.
echo ============================================================
echo  FALHA AO ABRIR - codigo %RC%
echo ============================================================
echo.

rem 0x80000003 = STATUS_BREAKPOINT: um CHECK() do Chromium na inicializacao.
rem Acontece com perfil corrompido, GPU incompativel ou sessao sem desktop.
if "%RC%"=="-2147483645" (
  echo Diagnostico: 0x80000003 STATUS_BREAKPOINT.
  echo O Chromium abortou antes de criar a janela. Causas comuns:
  echo   1. Perfil do Electron corrompido  -^> tente: ABRIR_RECONSTRUCAO_LIMPAR.bat
  echo   2. Driver de video incompativel   -^> tente: set PKA_SAFE_GPU=1 ^&^& ABRIR_RECONSTRUCAO.bat
  echo   3. Sessao sem desktop (servico/SSH)
  echo.
)

echo Ultimas linhas do log do Electron:
echo ------------------------------------------------------------
if exist "%PKA_LOG%" (
  powershell -NoProfile -Command "Get-Content -LiteralPath '%PKA_LOG%' -Tail 25 -ErrorAction SilentlyContinue"
) else (
  echo  (sem log: o Electron nao chegou a escrever)
)
echo ------------------------------------------------------------
echo Log completo: %PKA_LOG%
echo.

:failed
echo.
echo Pressione qualquer tecla para fechar.
pause >nul
exit /b 1
