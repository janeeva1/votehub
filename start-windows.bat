@echo off
REM Double-click to install (first time) and run the platform at http://localhost:3000
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required: https://nodejs.org & pause & exit /b 1)
if not exist .env (
  copy .env.example .env >nul
  echo Created .env - open it and set your PostgreSQL password in DATABASE_URL, then run this again.
  notepad .env
  pause
  exit /b 1
)
findstr /C:"YOUR_PASSWORD" .env >nul && (
  echo Please replace YOUR_PASSWORD in .env with your PostgreSQL password.
  notepad .env
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies, this takes a minute the first time...
  call npm install || (pause & exit /b 1)
)
call npm run dev
pause
