@echo off
REM Backup completo do Postgres (pg_dump) para a pasta backups\
cd /d %~dp0
if not exist backups mkdir backups
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmm"') do set DATA=%%i
docker exec painel-raspagem-db pg_dump -U painel -d painel > backups\painel_%DATA%.sql
echo Backup salvo em backups\painel_%DATA%.sql
echo Para restaurar em outro PC:  docker compose up -d  e depois
echo   type backups\painel_%DATA%.sql ^| docker exec -i painel-raspagem-db psql -U painel -d painel
