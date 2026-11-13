@echo off
setlocal
REM =============================================================
REM PROJECT PATH: Leave blank to use the folder containing this BAT.
REM If the BAT is stored elsewhere, change the path below, e.g.:
REM set "PROJECT_DIR=D:\nebuloid projcets\ai_booth"
REM =============================================================
set "PROJECT_DIR=%~dp0"
set "WEB_URL=http://localhost:3000/rajasthan"
set "APP_PROFILE=%TEMP%\EntranceCounterKioskProfile"

if not exist "%PROJECT_DIR%package.json" (
  echo ERROR: package.json not found in "%PROJECT_DIR%"
  echo Place this BAT in your project root or edit PROJECT_DIR.
  pause
  exit /b 1
)
if not exist "%PROJECT_DIR%worker\entry_counter.py" (
  echo ERROR: worker\entry_counter.py not found.
  pause
  exit /b 1
)
if not exist "%PROJECT_DIR%worker\.venv\Scripts\python.exe" (
  echo ERROR: Python virtual environment not found at worker\.venv
  pause
  exit /b 1
)

REM Start each service in its own visible console for troubleshooting.
start "Entrance Counter - Next.js" cmd /k "cd /d ""%PROJECT_DIR%"" && npm run dev"
start "Entrance Counter - Camera Worker" cmd /k "cd /d ""%PROJECT_DIR%worker"" && ""%PROJECT_DIR%worker\.venv\Scripts\python.exe"" entry_counter.py"

REM Wait up to 120 seconds for the Next.js server to answer.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='%WEB_URL%'; $ready=$false; for($i=0;$i -lt 60;$i++){try{$r=Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 400){$ready=$true;break}}catch{};Start-Sleep -Seconds 2};if(-not $ready){exit 1}"
if errorlevel 1 (
  echo ERROR: Web app did not become ready at %WEB_URL%.
  echo Check the Next.js console. The camera worker may still be running.
  pause
  exit /b 1
)

REM Prefer Edge, then Chrome. Kiosk hides browser chrome but is NOT a secure Windows lock.
set "BROWSER="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER (
  echo ERROR: Could not find Microsoft Edge or Google Chrome.
  pause
  exit /b 1
)

REM Dedicated profile keeps the kiosk separate from your everyday browser.
REM Allow camera access manually once in this profile if the browser prompts.
start "Entrance Counter Kiosk" "%BROWSER%" --kiosk "%WEB_URL%" --user-data-dir="%APP_PROFILE%" --no-first-run
exit /b 0
