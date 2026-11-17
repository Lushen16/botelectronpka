@echo off
setlocal
title PKA - Race probe (pega o pipe antes do menu)
cd /d "%~dp0.."

echo ==========================================================
echo   RACE PROBE - abre o pipe antes do menu e espera a chave
echo ==========================================================
echo.
echo 1. Este comando vai ficar esperando o jogo e o pipe.
echo 2. Deixe esta janela aberta.
echo 3. No jogo, dispare a INJECAO normalmente.
echo 4. Quando a chave aparecer, rode no outro terminal:
echo      python tools\find_channel_key.py --auto --write captures\channel-key.json
echo.
echo O probe autentica sozinho assim que o arquivo existir.
echo.

if not exist captures mkdir captures

python -u -B tools\race_probe.py --key-later --key-file captures\channel-key.json --seconds 900
echo.
echo saida=%ERRORLEVEL%
pause
