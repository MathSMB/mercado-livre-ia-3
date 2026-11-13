@echo off
REM Sobe tudo: banco (Docker, se estiver aberto), site de teste, backend e painel.
cd /d %~dp0
docker compose up -d 2>nul || echo Docker nao encontrado: o historico vai usar SQLite (backend\painel.db).
start "Site de teste" cmd /k "cd backend && python site_ficticio.py"
start "Backend (API)" cmd /k "cd backend && pip install -q -r requirements.txt && uvicorn app:app --reload --port 8001"
start "Painel" cmd /k "cd frontend && npm install && npm run dev"
timeout /t 8 >nul
start http://localhost:5173
