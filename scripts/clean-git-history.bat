@echo off
setlocal EnableExtensions
rem ------------------------------------------------------------------------------
rem  Replaces the repository history with ONE fresh commit authored by you, and
rem  removes every trace of the old Replit history (commits, the "replit-agent"
rem  branch, Replit backup remote). Your current files stay exactly as they are.
rem  Run it from the project folder:  scripts\clean-git-history.bat
rem ------------------------------------------------------------------------------
cd /d "%~dp0\.."
where git >nul 2>nul || (echo Git is not installed. Install it from https://git-scm.com and run this again. & pause & exit /b 1)
if not exist .git (echo This folder is not a Git repository. & pause & exit /b 1)

echo.
echo This will REWRITE the history of your GitHub repository:
echo   - all old commits (including the Replit Agent ones) are replaced by one new commit
echo   - the "replit-agent" branch is deleted on GitHub
echo   - your files are NOT changed
echo.
set /p OK=Type YES to continue: 
if /i not "%OK%"=="YES" (echo Cancelled. & pause & exit /b 0)

set GHNAME=
set /p GHNAME=Your name for the commit [janeeva1]: 
if "%GHNAME%"=="" set GHNAME=janeeva1
set GHEMAIL=
set /p GHEMAIL=The email on your GitHub account [janeeva132@gmail.com]: 
if "%GHEMAIL%"=="" set GHEMAIL=janeeva132@gmail.com
git config user.name "%GHNAME%"
git config user.email "%GHEMAIL%"

rem Replit leftovers
if exist .replit del /f /q .replit
if exist replit.md del /f /q replit.md
git remote remove gitsafe-backup >nul 2>nul
git config --remove-section "lfs.http://gitsafe:5419" >nul 2>nul

rem One clean commit containing the current files (respecting .gitignore, so .env is never included)
git checkout -q --orphan fresh-main || goto :fail
git rm -r -q --cached . >nul 2>nul
git add -A || goto :fail
git commit -q -m "VoteHub voting platform" || goto :fail
git branch -D main >nul 2>nul
git branch -D replit-agent >nul 2>nul
git branch -m main || goto :fail
git update-ref -d refs/replit/agent-ledger >nul 2>nul
git update-ref -d refs/remotes/gitsafe-backup/main >nul 2>nul
git update-ref -d refs/remotes/origin/replit-agent >nul 2>nul

echo.
echo Pushing to GitHub (you may be asked to sign in)...
git push --force -u origin main || goto :fail
git push origin --delete replit-agent >nul 2>nul

git reflog expire --expire=now --all
git gc --prune=now --quiet

echo.
echo Done. GitHub now has a single commit by %GHNAME%.
echo The Contributors list on GitHub can take up to a day to refresh.
pause
exit /b 0

:fail
echo.
echo Something went wrong (see the message above). Nothing was pushed unless it says so.
pause
exit /b 1
