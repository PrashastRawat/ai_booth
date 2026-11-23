# Upgrade the existing exhibition PC without losing visitor history

This is an upgrade of the existing installation. Keep its `data/` directory in place.
Never copy a development database onto that PC, restore an older backup over newer
data, delete `data/`, use `git clean -fdx`, or use `git reset --hard` for deployment.
Do not run old and new app versions against the same database.

**Current exhibition deployment status: BLOCKED until its installed build, historical
rate, and actual database copy pass the checks below.** Local synthetic tests do not
verify that PC's approximately 200,000 total. No commit, push, fetch, pull, or deployment
is authorized by this document; the owner must approve GitHub operations first.

## What is protected

- `data/entries.db`, its WAL/SHM/journal files, and backups are not tracked in the
  audited development index. `/data/` is ignored; additional SQLite/backup patterns
  now cover other directories too. The PC and incoming commit must also pass inspection.
- `git-check` inspects the index or target commit, including SQLite file headers, so
  ignored-but-already-tracked files cannot slip through. If it finds one, STOP. Removing
  a tracked database from Git can make a later pull delete that file on another PC.
  A maintainer must plan an external backup and an explicit data-preserving transition.
- This project's install/start/build scripts do not delete visitor records. `npm ci`
  replaces `node_modules`, not `data`. There are no project install lifecycle hooks.
  Dependencies can have install scripts; use `--ignore-scripts` below. No dependency
  changes are needed for this upgrade. Build routes defer SQLite access to requests.
- Schema initialization uses `CREATE ... IF NOT EXISTS` and additive columns/indexes.
  It does not reset `entries` or rewrite closed projection sessions. A first poll may
  close a stale open session at its last heartbeat and open a new segment.
- Unversioned history is interpreted as **2,000/hour**, only if that is confirmed to
  match the PC's history. Stored explicit rates are preserved. New activity records
  **2,000 per 3,600 active seconds before 11:00 IST and 6,500 from 11:00 IST**. No
  nine-hour timer exists.

The helper never calls `getDb()` on the live file. `preflight` and `verify-live` use
read-only SQLite connections without schema initialization or HTTP requests. `backup`
reads the source using SQLite's [backup API](https://nodejs.org/download/release/v22.18.0/docs/api/sqlite.html#sqlitebackupsourceDb-destination-options), including committed WAL data.
`verify-copy` alone migrates and simulates activity, inside a new scratch directory.
Existing output files are never overwritten. Keep all reports/backups outside the checkout.

## Development PC: review and prepare the safety kit

Use PowerShell. The examples use the existing project folder. Node **22.18+**, or a
supported newer version, is required for these TypeScript and SQLite tools. Check
`node --version`; do not change Node on the exhibition PC during this upgrade without review.

```powershell
Set-Location -LiteralPath 'D:\nebuloid projcets\ai_booth'
$ErrorActionPreference = 'Stop'
function Check-Exit { if ($LASTEXITCODE -ne 0) { throw 'STOP: the previous command failed. Do not continue.' } }
git status --short
git diff --check
Check-Exit
git diff
git ls-files
node scripts/deployment-safety.mts git-check --repo (Get-Location).Path
Check-Exit
npm test
Check-Exit
npx tsc --noEmit
Check-Exit
npm run lint
Check-Exit
npm run build
Check-Exit
```

Prepare an offline kit so the PC can test the **new** migration **before** pulling it.
This contains code and documentation only. It imports the candidate migration directly;
the installed app remains stopped and unchanged throughout the copy test.

```powershell
$KitStage = Join-Path $env:TEMP ('ai-booth-safety-kit-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $KitStage 'scripts') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $KitStage 'src\lib') | Out-Null
Copy-Item -LiteralPath 'scripts\deployment-safety.mts' -Destination (Join-Path $KitStage 'scripts')
foreach ($Name in @('db.ts','projection.ts','time.ts','visitors.ts')) {
    Copy-Item -LiteralPath (Join-Path 'src\lib' $Name) -Destination (Join-Path $KitStage 'src\lib')
}
Copy-Item -LiteralPath DEPLOYMENT.md -Destination $KitStage
$KitZip = $KitStage + '.zip'
Compress-Archive -Path (Join-Path $KitStage '*') -DestinationPath $KitZip
Get-FileHash -LiteralPath $KitZip -Algorithm SHA256
Write-Output $KitZip
```

Transfer this ZIP through an approved local file transfer/USB method; record its SHA256
and verify it on the PC. Do not transfer `data/`. The tool will later verify that the
pulled counting code matches the kit's tested code. Recreate the kit if that code changes.

**Only after owner approval**, stage application code, tests and documentation explicitly:

```powershell
git add -- .gitignore README.md DEPLOYMENT.md scripts/deployment-safety.mts src/lib/deploymentSafety.test.mts src/lib/projection.ts src/lib/projection.test.mts src/lib/counterAnimation.ts src/lib/counterAnimation.test.mts src/lib/odometerWheel.ts src/app/api/projection/route.ts src/app/api/stats/route.ts src/components/Dashboard.tsx src/components/rajasthan/Odometer.tsx src/components/rajasthan/RajasthanDashboard.tsx
Check-Exit
git diff --cached --stat
git diff --cached
node scripts/deployment-safety.mts git-check --repo (Get-Location).Path
Check-Exit
git commit -m 'Preserve projection history and add verified exhibition upgrade procedure'
Check-Exit
git rev-parse HEAD
git push
Check-Exit
```

Give the operator that exact approved commit SHA, the kit ZIP, and its hash. If unrelated
files are already staged, stop and resolve the staging selection before committing.

## Exhibition PC: stop, identify, and record the installation

Close the kiosk/dashboard, stop the Python worker with Ctrl+C, and stop Next.js with
Ctrl+C in its own console. Disable any automatic restart for this maintenance window.
The existing launchers use `npm run dev` and do not delete data; verify which launcher
is actually used on this PC. Do not launch a second instance during checks.

In a separate PowerShell window:

```powershell
$ErrorActionPreference = 'Stop'
function Check-Exit { if ($LASTEXITCODE -ne 0) { throw 'STOP: the previous command failed. Do not continue.' } }
$Project = 'D:\nebuloid projcets\ai_booth'
Set-Location -LiteralPath $Project
$Run = Join-Path (Split-Path -Parent $Project) ('ai-booth-upgrade-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $Run | Out-Null
# Set this to the transferred kit ZIP's actual location.
$KitZip = 'D:\ai-booth-safety-kit.zip'
Get-FileHash -LiteralPath $KitZip -Algorithm SHA256
# Compare with the developer's hash. STOP if different.
$Kit = Join-Path $Run 'kit'
Expand-Archive -LiteralPath $KitZip -DestinationPath $Kit
$Tool = Join-Path $Kit 'scripts\deployment-safety.mts'
node --version
git status --short --untracked-files=all
git rev-parse HEAD
git ls-files
git check-ignore --no-index data/entries.db data/entries.db-wal data/entries.db-shm
Check-Exit
node $Tool git-check --repo $Project --require-clean
Check-Exit
Get-Item -LiteralPath (Join-Path $Project 'data\entries.db') | Select-Object FullName,Length,LastWriteTime
Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|python|pythonw)\.exe$' } | Select-Object ProcessId,CommandLine
Get-NetTCPConnection -LocalPort 3000,8765 -State Listen -ErrorAction SilentlyContinue
```

Check the process list yourself: the app/worker must be stopped. Use the configured ports
if different. Do not terminate unrelated Node/Python applications. Wait **over two minutes**
after the final heartbeat before the baseline (for example, wait three minutes on a clock).
Otherwise a formerly live session can appear to shrink when its inactivity cutoff expires.

If Git status is not empty, **STOP**. Local `worker/config.json`, launcher changes or
untracked files can be important. Preserve them outside the repository and ask a maintainer
to review each change. A maintainer can commit intended local changes to a separate local
branch and reconcile them with the approved upgrade. This can require a reviewed merge;
do not force a fast-forward, blindly stash/restore, or discard files to make the check pass.
No automated cleanup is provided.

Confirm the source rate and startup folder read-only:

```powershell
Select-String -LiteralPath 'src\lib\projection.ts' -Pattern 'export const PER_HOUR','export const CURRENT_RATE','export const LEGACY_RATE'
git log -5 --oneline -- src/lib/projection.ts
Get-Content -LiteralPath 'Start_Entrance_Counter.bat' | Select-String 'PROJECT_DIR','npm run'
Get-Content -LiteralPath 'counter.bat' | Select-String 'PROJECT_DIR','npm run'
if (Test-Path -LiteralPath '.next\BUILD_ID') { Get-Content -LiteralPath '.next\BUILD_ID' }
```

The helper recognizes the exact audited legacy source (2,000/hour), or this kit's current
versioned implementation. An unknown source variant is blocked and needs a developer audit.
Confirm that **all unversioned historical activity** used 2,000/hour from deployment records
or previously verified versions. Today's source does not prove the rate used four days ago.

Also confirm that the stopped runtime used these exact sources and this folder. If it used
the documented dev launcher, it compiles the checked-out source. If it ran a production
build, establish which source commit built that artifact; `BUILD_ID` alone does not prove
the rate. If you cannot establish that connection or the historical rate, **deployment stays
BLOCKED**. Do not pass the confirmation flags below just to bypass a blocker.

With those checks complete, set `$Runtime` to `development` for the existing dev launcher,
or `production` for `npm start`. This selects the same Next.js `.env` precedence. Run in
the same shell environment used to launch the app, preserving `EVENT_START_DATE` and
`EVENT_END_DATE`. Do not print or copy unrelated environment secrets.

```powershell
$Runtime = 'development'
$Baseline = Join-Path $Run 'baseline.json'
node $Tool preflight --repo $Project --runtime $Runtime --installed-rate 2000 --legacy-rate 2000 --confirm-runtime-source --out $Baseline
Check-Exit
$Before = Get-Content -LiteralPath $Baseline -Raw | ConvertFrom-Json
$Before | Select-Object status,dbPath,installedRate,at
$Before.counts
$Before.inventory | Select-Object rawEntryCount,sessionCount,eventIdsHash,segmentColumns
```

`--installed-rate 2000` is for the confirmed old build. If the PC already runs the exact
current versioned code, use `6500`, retaining `--legacy-rate 2000` only after historical
verification. A partial schema, invalid rates, recent heartbeat, unknown version, dirty
tree, missing database or missing confirmation blocks deployment. If the recorded projected
total differs unexpectedly from the PC's last known total, STOP and reconcile the build,
scope and last activity; do not set an arbitrary baseline of 200,000.

## Back up and test the candidate on a copy, before pulling

```powershell
$Backup = Join-Path $Run 'exhibition-backup.sqlite'
node $Tool backup --repo $Project --baseline $Baseline --services-stopped --out $Backup
Check-Exit
Get-FileHash -LiteralPath $Backup -Algorithm SHA256
Get-Content -LiteralPath ($Backup + '.manifest.json')
$CopyTest = Join-Path $Run 'migration-check'
node $Tool verify-copy --repo $Project --baseline $Baseline --backup $Backup --out $CopyTest
Check-Exit
$Result = Join-Path $CopyTest 'result.json'
Get-Content -LiteralPath $Result -Raw
```

Backup validates `PRAGMA integrity_check` and baseline row fingerprints, including events
present only in WAL. A `.db` file copied without its live WAL is not an acceptable backup.
The manifest ties the immutable backup to this exact baseline. Failed/incomplete output
is never reused; investigate, then use a **new** `$Run` directory for a new attempt.

The copy test must say `PASS`. It checks all original event IDs/payloads, session rows and
state, additive/idempotent migration, and exact frozen before/after raw and projected
today/total counts. Historical rates stay unchanged; a new simulated hour adds exactly
6,500. That future simulation uses a fresh IST day and unrestricted event scope; the frozen
historical comparison uses the installation's actual event scope. The simulated database
is disposable test evidence: **never copy it back to `data/`**.

## Pull only the approved, inspected code

These are GitHub operations: run only after approval and after every preceding check passes.

```powershell
# Replace with the developer's full approved SHA, not a branch name.
$UpgradeCommit = 'PASTE_FULL_APPROVED_COMMIT_SHA'
git fetch origin $UpgradeCommit
Check-Exit
git rev-parse FETCH_HEAD
# Confirm FETCH_HEAD is exactly the approved SHA.
node $Tool git-check --repo $Project --ref $UpgradeCommit --require-clean
Check-Exit
git merge-base --is-ancestor HEAD $UpgradeCommit
Check-Exit
git diff --stat HEAD $UpgradeCommit
git diff HEAD $UpgradeCommit -- package.json package-lock.json .gitignore src/lib/db.ts src/lib/projection.ts
# Review: no runtime data paths, destructive hooks or unexpected dependency changes.
git pull --ff-only origin $UpgradeCommit
Check-Exit
if ((git rev-parse HEAD) -ne $UpgradeCommit) { throw 'STOP: pulled a different commit.' }
node $Tool git-check --repo $Project --require-clean
Check-Exit
node $Tool verify-live --repo $Project --baseline $Baseline --backup $Backup --result $Result --runtime $Runtime
Check-Exit
```

`--ff-only` stops on diverged branches; it never resolves conflicts by discarding local
work. Current index, incoming tree, ignored runtime paths and local changes must all be
checked. Given those passing checks, Git has no tracked exhibition database to overwrite
or delete during the approved pull. This is not a guarantee about arbitrary future commits.

## Build, restart, and measure only new activity

No package/dependency changes are part of this upgrade; keep installed dependencies if
already correct. If the approved dependency diff or installation state requires a refresh,
run this first (it leaves `data/` in place and suppresses dependency lifecycle scripts):

```powershell
npm ci --ignore-scripts
Check-Exit
```

Use `npm install --ignore-scripts` only if a maintainer specifically needs to update the
lockfile; do not do that during routine exhibition deployment. Do not use either command
to fix an unexplained database/count discrepancy.

```powershell
npm test
Check-Exit
npx tsc --noEmit
Check-Exit
npm run lint
Check-Exit
npm run build
Check-Exit
node $Tool verify-live --repo $Project --baseline $Baseline --backup $Backup --result $Result --runtime $Runtime
Check-Exit
```

Keep the prior startup mode/environment for this upgrade: the existing kiosk launcher uses
development mode even after a production build. Start it normally once. If using separate
consoles instead, use these commands from the project root:

```powershell
# Web console: choose the one matching $Runtime; do not run both.
npm run dev
# OR, only when $Runtime is production:
# npm run start
```

```powershell
# Worker console, from the same project root:
Set-Location -LiteralPath 'D:\nebuloid projcets\ai_booth\worker'
.\.venv\Scripts\python.exe entry_counter.py
```

Open `http://localhost:3000/rajasthan`. Then, in the maintenance PowerShell window:

```powershell
node $Tool verify-live --repo $Project --baseline $Baseline --backup $Backup --result $Result --runtime $Runtime
Check-Exit
# This request is AFTER restart; it marks projection activity and is not a read-only preflight.
$After = Invoke-RestMethod 'http://localhost:3000/api/stats'
$After | Select-Object serverTime,todayVisitors,totalVisitors,projectedTodayVisitors,projectedTotalVisitors
$After.projection
```

`verify-live` confirms every original event and session still exists, with unchanged old
rates and frozen historical projection. It reports measured new raw events and projected
activity separately, and checks:

`current cumulative = baseline cumulative + measured new raw + measured new projection`.

New late camera events may legitimately belong to an older day; the tool preserves old
event rows and accounts for those additional records. Today's number may reset at IST
midnight while Total remains cumulative. The API poll is at a later timestamp than the
offline check; record its `serverTime` and new activity rather than expecting identical
moving totals. Stop and investigate any failed check or unexplained decrease. Keep the
entire external `$Run` folder and approved commit IDs as upgrade evidence.

## Rollback without losing visitors

1. Stop the app, worker and dashboards. Preserve the **newest** live database and its WAL
   before any recovery. Use the SQLite backup helper with a newly verified baseline/new
   output, or have a maintainer take a consistent backup; never reuse the pre-upgrade filename.
2. Leave the live database in place. Do not restore the pre-upgrade backup over it: that
   would discard camera events and activity recorded after the backup.
3. Do not simply run the old pre-versioning build. It reads all sessions at 2,000/hour
   and ignores new per-session rates, so its displayed cumulative total can be wrong.
4. Prefer a forward fix, or a reviewed rollback build retaining this rate-aware backend
   while reverting the faulty UI change. It must understand both historical 2,000/hour
   and new 6,500/hour segments (plus any 5,500/hour segments already recorded). Test that build on a copy of the **newest** database first.
5. If an old backup must be used for forensic recovery, keep both generations untouched.
   A maintainer must reconcile event IDs and rate-stamped activity on copies, preserving
   every newer event and avoiding overlapping sessions. There is no automatic restore or
   merge command. Resume only after the recovered copy passes comparison and review.

Do not proceed with a code-only rollback to an incompatible reader, or an automatic
database restore. GitHub recovery operations also require owner approval.
