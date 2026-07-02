## Run it

## Run/update with PM2

CMD one-liner, downloads or updates into `Music\chek` and runs PM2 through `npx`, so PM2 does not need to be installed globally:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $music=[Environment]::GetFolderPath('MyMusic'); $dest=Join-Path $music 'chek'; $zip=Join-Path $env:TEMP 'chek-update.zip'; $tmp=Join-Path $env:TEMP ('chek-update-' + [guid]::NewGuid()); if(-not (Test-Path $dest)){New-Item -ItemType Directory -Path $dest | Out-Null}; Invoke-WebRequest -Uri 'https://github.com/suijindagoat/chek/archive/refs/heads/main.zip' -OutFile $zip; Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force; $src=(Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1).FullName; Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force; Set-Location $dest; npm install; if($LASTEXITCODE){exit $LASTEXITCODE}; npx --yes pm2@latest startOrRestart ecosystem.config.cjs; exit $LASTEXITCODE"
```

`npm run pm2:start` runs:

```bat
npx --yes pm2@latest startOrRestart ecosystem.config.cjs
```

