@echo off
cd /d %~dp0
title Memory Recall Server
echo Starting Memory Recall Server...
echo Data dir: %USERPROFILE%\.memory-recall\data
echo Qdrant: localhost:6333
echo Ollama: localhost:11434
echo.
python -m src.server
