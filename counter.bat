@echo off
setlocal
title AI Booth Kiosk Launcher

REM ============================================================================
REM  AI BOOTH - KIOSK LAUNCHER
REM
REM  First run (double-click this file):
REM     - creates a Desktop shortcut "AI Booth Kiosk"
REM     - asks if you want to launch now
REM
REM  Shortcut (runs this file with "launch"):
REM     1. starts "npm run dev" (Next.js)            - minimized window
REM     2. starts worker\entry_counter.py in venv     - minimized window
REM     3. waits until http://localhost:3000/rajasthan responds
REM     4. opens Chrome (or Edge) in full-screen KIOSK mode,
REM        camera permission auto-allowed
REM     5. blocks ALL keyboard + mouse input
REM     6. press ESC  -> closes kiosk browser, stops servers, unlocks input
REM
REM  Emergency: Ctrl+Alt+Del always works (Windows does not allow blocking it).
REM ============================================================================


REM ===================== CONFIG - CHANGE THESE IF NEEDED ======================

REM >>> CHANGE THIS if the project folder moves.
REM >>> It must be the folder that contains package.json (where you run npm run dev).
set "PROJECT_DIR=D:\nebuloid projcets\ai_booth"

REM >>> Change only if the worker folder / script / venv name changes.
set "WORKER_DIR=%PROJECT_DIR%\worker"
set "WORKER_SCRIPT=entry_counter.py"
set "VENV_ACTIVATE=.venv\Scripts\activate.bat"

REM >>> Change if the Next.js app runs on a different port.
set "APP_URL=http://localhost:3000"

REM >>> Page the kiosk opens on. Change this to open a different route.
set "APP_ROUTE=/rajasthan"
set "KIOSK_URL=%APP_URL%%APP_ROUTE%"

REM >>> Name of the Desktop shortcut.
set "SHORTCUT_NAME=AI Booth Kiosk"

REM >>> 1 = ESC also stops npm run dev + the worker. 0 = leave them running.
set "STOP_SERVERS_ON_EXIT=1"

REM >>> Max seconds to wait for the Next.js server to come up.
set "SERVER_WAIT_SECONDS=180"

REM ============================================================================


REM ---- values passed to the embedded PowerShell section ----
set "AIBOOTH_BAT=%~f0"
set "AIBOOTH_PROJECT=%PROJECT_DIR%"
set "AIBOOTH_URL=%KIOSK_URL%"
set "AIBOOTH_SHORTCUT_NAME=%SHORTCUT_NAME%"
set "AIBOOTH_STOP_SERVERS=%STOP_SERVERS_ON_EXIT%"
set "AIBOOTH_WAIT_SECONDS=%SERVER_WAIT_SECONDS%"
REM Separate browser profile so kiosk flags always apply and your normal
REM Chrome/Edge windows are never touched.
set "AIBOOTH_PROFILE=%LOCALAPPDATA%\AIBoothKioskProfile"

REM ---- sanity checks ----
if not exist "%PROJECT_DIR%\package.json" (
    echo ERROR: package.json not found in "%PROJECT_DIR%"
    echo Edit PROJECT_DIR at the top of this file.
    pause
    exit /b 1
)
if not exist "%WORKER_DIR%\%WORKER_SCRIPT%" (
    echo ERROR: "%WORKER_DIR%\%WORKER_SCRIPT%" not found.
    echo Edit WORKER_DIR / WORKER_SCRIPT at the top of this file.
    pause
    exit /b 1
)
if not exist "%WORKER_DIR%\%VENV_ACTIVATE%" (
    echo ERROR: venv not found at "%WORKER_DIR%\%VENV_ACTIVATE%"
    pause
    exit /b 1
)

REM ---- find a browser: Chrome first, then Edge ----
set "AIBOOTH_BROWSER="
for %%P in (
    "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    "%LocalAppData%\Google\Chrome\Application\chrome.exe"
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do (
    if not defined AIBOOTH_BROWSER if exist %%P set "AIBOOTH_BROWSER=%%~P"
)
if not defined AIBOOTH_BROWSER (
    echo ERROR: Neither Google Chrome nor Microsoft Edge was found.
    pause
    exit /b 1
)

if /i "%~1"=="launch" goto :launch


REM ============================ SETUP MODE ====================================
echo Creating Desktop shortcut "%SHORTCUT_NAME%" ...
call :ps shortcut
echo.
echo Done. From now on just double-click "%SHORTCUT_NAME%" on the Desktop.
echo Press ESC while the kiosk is open to exit.
echo.
choice /c YN /m "Launch the kiosk now"
if errorlevel 2 exit /b 0


REM ============================ LAUNCH MODE ===================================
:launch
echo Cleaning up any previous kiosk session...
call :ps cleanup

echo Starting Next.js dev server...
start "AI Booth - Web" /min /d "%PROJECT_DIR%" cmd /k "set AIBOOTH_TAG=web& npm run dev"

echo Starting worker (%WORKER_SCRIPT%)...
start "AI Booth - Worker" /min /d "%WORKER_DIR%" cmd /k "set AIBOOTH_TAG=worker& call %VENV_ACTIVATE%& python %WORKER_SCRIPT%"

echo Waiting for %KIOSK_URL% ...
call :ps wait
if errorlevel 1 goto :server_failed

echo Opening kiosk browser...
start "" "%AIBOOTH_BROWSER%" --kiosk "%KIOSK_URL%" --edge-kiosk-type=fullscreen --user-data-dir="%AIBOOTH_PROFILE%" --use-fake-ui-for-media-stream --no-first-run --no-default-browser-check --disable-session-crashed-bubble --disable-features=TranslateUI --overscroll-history-navigation=0 --disable-pinch --autoplay-policy=no-user-gesture-required

REM give the kiosk window time to appear and take focus
timeout /t 4 /nobreak >nul

echo Keyboard and mouse locked. Press ESC to exit.
call :ps lock

echo Kiosk closed.
exit /b 0


:server_failed
echo.
echo ERROR: %KIOSK_URL% did not respond within %SERVER_WAIT_SECONDS% seconds.
echo Check the "AI Booth - Web" window for errors.
call :ps cleanup
pause
exit /b 1


REM ---- runs the PowerShell section at the bottom of this file ----
:ps
set "AIBOOTH_MODE=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:AIBOOTH_BAT); $m='##'+'PS_START##'; iex $s.Substring($s.IndexOf($m)+$m.Length)"
exit /b %errorlevel%


REM ============================================================================
REM  Everything below is PowerShell, read by the :ps routine above.
REM  cmd never executes it. Do not edit unless you know what you are doing.
REM ============================================================================
##PS_START##
$ErrorActionPreference = 'SilentlyContinue'

function Get-ProcsWithCmd {
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine }
}

# Kill only the kiosk browser (identified by its private profile folder)
function Stop-KioskBrowser {
    $p = $env:AIBOOTH_PROFILE
    Get-ProcsWithCmd |
        Where-Object { $_.CommandLine.IndexOf($p, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

# Kill only the npm/worker windows this launcher started (tagged), plus their children
function Stop-Servers {
    Get-ProcsWithCmd |
        Where-Object { $_.CommandLine.IndexOf('AIBOOTH_TAG=', [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
        ForEach-Object { taskkill.exe /PID $_.ProcessId /T /F | Out-Null }
}

switch ($env:AIBOOTH_MODE) {

    'shortcut' {
        $desktop = [Environment]::GetFolderPath('Desktop')
        $lnkPath = Join-Path $desktop ($env:AIBOOTH_SHORTCUT_NAME + '.lnk')
        $ws  = New-Object -ComObject WScript.Shell
        $lnk = $ws.CreateShortcut($lnkPath)
        $lnk.TargetPath       = $env:AIBOOTH_BAT
        $lnk.Arguments        = 'launch'
        $lnk.WorkingDirectory = $env:AIBOOTH_PROJECT
        $lnk.WindowStyle      = 7   # minimized launcher window
        $lnk.Description      = 'Launch AI Booth in kiosk mode (ESC to exit)'
        if ($env:AIBOOTH_BROWSER) { $lnk.IconLocation = "$($env:AIBOOTH_BROWSER),0" }
        $lnk.Save()
        Write-Host "Shortcut created: $lnkPath"
    }

    'cleanup' {
        Stop-KioskBrowser
        Stop-Servers
    }

    'wait' {
        $deadline = (Get-Date).AddSeconds([int]$env:AIBOOTH_WAIT_SECONDS)
        while ((Get-Date) -lt $deadline) {
            try {
                # first request also triggers Next.js compile, so the kiosk opens on a ready page
                $req = [Net.WebRequest]::Create($env:AIBOOTH_URL)
                $req.Timeout = 120000
                $resp = $req.GetResponse()
                $resp.Close()
                exit 0
            } catch [Net.WebException] {
                if ($_.Exception.Response) { exit 0 }   # server answered (even 404/500) = it is up
            } catch {}
            Start-Sleep -Seconds 2
        }
        exit 1
    }

    'lock' {
        $cs = @'
using System;
using System.Runtime.InteropServices;

public static class KioskLock {
    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }

    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, HookProc fn, IntPtr hMod, uint threadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);

    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const int WM_KEYDOWN = 0x100;
    private const int WM_SYSKEYDOWN = 0x104;
    private const uint VK_ESCAPE = 0x1B;

    // kept in static fields so the GC never collects the callbacks
    private static HookProc kbProc = KeyboardHook;
    private static HookProc msProc = MouseHook;
    private static IntPtr kbHook = IntPtr.Zero;
    private static IntPtr msHook = IntPtr.Zero;

    private static IntPtr KeyboardHook(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            int msg = wParam.ToInt32();
            if (k.vkCode == VK_ESCAPE && (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN)) {
                PostQuitMessage(0);      // ESC = exit kiosk
            }
            return (IntPtr)1;            // swallow every key (Win, Alt+Tab, Alt+F4, F11, ...)
        }
        return CallNextHookEx(kbHook, nCode, wParam, lParam);
    }

    private static IntPtr MouseHook(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            return (IntPtr)1;            // swallow all mouse moves, clicks and scrolls
        }
        return CallNextHookEx(msHook, nCode, wParam, lParam);
    }

    public static void Run() {
        // park the cursor in the bottom-right corner, out of the way
        SetCursorPos(GetSystemMetrics(0) - 1, GetSystemMetrics(1) - 1);

        IntPtr hMod = GetModuleHandle(null);
        kbHook = SetWindowsHookEx(WH_KEYBOARD_LL, kbProc, hMod, 0);
        msHook = SetWindowsHookEx(WH_MOUSE_LL, msProc, hMod, 0);

        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }

        if (kbHook != IntPtr.Zero) UnhookWindowsHookEx(kbHook);
        if (msHook != IntPtr.Zero) UnhookWindowsHookEx(msHook);
    }
}
'@
        Add-Type -TypeDefinition $cs -Language CSharp
        [KioskLock]::Run()      # blocks here until ESC is pressed

        Stop-KioskBrowser
        if ($env:AIBOOTH_STOP_SERVERS -eq '1') { Stop-Servers }
    }
}