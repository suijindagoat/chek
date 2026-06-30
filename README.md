## Run it

```sh
npm install
npm start
```

## Run/update with PM2

CMD one-liner, downloads or updates into `Music\chek` without deleting `.chrome-profile`:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $music=[Environment]::GetFolderPath('MyMusic'); $dest=Join-Path $music 'chek'; $zip=Join-Path $env:TEMP 'chek-update.zip'; $tmp=Join-Path $env:TEMP ('chek-update-' + [guid]::NewGuid()); if(-not (Test-Path $dest)){New-Item -ItemType Directory -Path $dest | Out-Null}; Invoke-WebRequest -Uri 'https://github.com/suijindagoat/chek/archive/refs/heads/main.zip' -OutFile $zip; Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force; $src=(Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1).FullName; Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force; Set-Location $dest; if(-not (Get-Command pm2 -ErrorAction SilentlyContinue)){npm install -g pm2; if($LASTEXITCODE){exit $LASTEXITCODE}}; npm install; if($LASTEXITCODE){exit $LASTEXITCODE}; npm run pm2:start; exit $LASTEXITCODE"
```

`npm run pm2:start` runs:

```bat
pm2 startOrRestart ecosystem.config.cjs
```

Close the terminal and PM2 keeps it running.

PM2 restarts only restart the Node controller. Chrome is launched separately with a debugging port, so the same Chrome window and `.chrome-profile` can stay open while Node reconnects after an update. Chrome chooses a free debugging port by default, avoiding fixed-port conflicts.

The PM2 config also starts `clipkey-updater`. It checks GitHub every 5 minutes. When the latest commit changes, it downloads the GitHub ZIP, overwrites/appends the files in this folder, runs `npm install`, then restarts only `clipkey-flag`. It does not delete `.chrome-profile`.

The first updater run stores the current GitHub commit as its baseline. New commits after that are applied automatically.

## Files it creates

- `.chrome-profile/` - persistent browser profile.
- `.device-id` - device id used for activation.
- `.github-update-state.json` - last GitHub commit applied by the updater.
