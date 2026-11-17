@echo off
cd /d "%~dp0"
start "" http://localhost:6060
python server.py
