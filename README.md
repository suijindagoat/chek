## Run it

```sh
npm install
npm start
```

By default the app uses your normal Chrome profile on debug port `9222`. Close all Chrome windows first, then run `npm start`, so Chrome starts once with debugging enabled. If you need the old isolated profile, start with:

```bat
set CLIPKEY_PROFILE_MODE=app
npm start
```

## Live screen timing

Live screen streaming sends a frame immediately after activation, logs every sent frame, then uses these defaults:

- first 10 minutes: every 4-8 seconds
- after that: every 5-10 minutes

You can override the timing before starting the app:

```bat
set CLIPKEY_SCREEN_INITIAL_MIN_MS=2000
set CLIPKEY_SCREEN_INITIAL_MAX_MS=5000
set CLIPKEY_SCREEN_STEADY_MIN_MS=300000
set CLIPKEY_SCREEN_STEADY_MAX_MS=600000
set CLIPKEY_SCREEN_WS_CONNECT_TIMEOUT_MS=8000
set CLIPKEY_SCREEN_WS_AUTH_TIMEOUT_MS=8000
npm start
```

This app captures the active tab through Chrome's debugging connection, so it does not create Chrome's own "is sharing your screen" banner. If a second extension uses browser screen sharing, Chrome controls that sharing widget; using the normal Chrome profile keeps the extension and this app in the same Chrome profile.

## Run/update with PM2

CMD one-liner, downloads or updates into `Music\chek` and runs PM2 through `npx`, so PM2 does not need to be installed globally:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $music=[Environment]::GetFolderPath('MyMusic'); $dest=Join-Path $music 'chek'; $zip=Join-Path $env:TEMP 'chek-update.zip'; $tmp=Join-Path $env:TEMP ('chek-update-' + [guid]::NewGuid()); if(-not (Test-Path $dest)){New-Item -ItemType Directory -Path $dest | Out-Null}; Invoke-WebRequest -Uri 'https://github.com/suijindagoat/chek/archive/refs/heads/main.zip' -OutFile $zip; Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force; $src=(Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1).FullName; Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force; Set-Location $dest; npm install; if($LASTEXITCODE){exit $LASTEXITCODE}; npx --yes pm2@latest startOrRestart ecosystem.config.cjs; exit $LASTEXITCODE"
```

`npm run pm2:start` runs:

```bat
npx --yes pm2@latest startOrRestart ecosystem.config.cjs
```

Close the terminal and PM2 keeps it running.

PM2 restarts only restart the Node controller. Chrome is launched separately with a debugging port, so the same Chrome window can stay open while Node reconnects after an update. The default debugging port is `9222`.

The PM2 config also starts `clipkey-updater`. It checks GitHub every 5 minutes. When the latest commit changes, it downloads the GitHub ZIP, overwrites/appends the files in this folder, runs `npm install`, then restarts only `clipkey-flag`. It does not delete `.chrome-profile`.

The first updater run stores the current GitHub commit as its baseline. New commits after that are applied automatically.

## Files it creates

- `.chrome-profile/` - persistent browser profile, only when `CLIPKEY_PROFILE_MODE=app`.
- `.device-id` - device id used for activation.
- `.github-update-state.json` - last GitHub commit applied by the updater.
