## Run it

```sh
npm install
npm start
```

By default the app launches one dedicated automated Chrome profile at `.chrome-profile`, using the same direct Puppeteer launch style as the older working code. The profile is wiped each run so Chrome starts clean.

After activation, use the TinyMCE branding click to request an answer. TinyMCE branding-click answering starts enabled and can be toggled with `Ctrl+Alt+Shift+X`. No answer command text is required. The other helper shortcuts remain disabled until `Ctrl+Shift+C` is pressed.

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

This app captures the active tab through Puppeteer's Chrome connection, so it does not create Chrome's own "is sharing your screen" banner.

## Run/update with PM2

CMD one-liner, downloads or updates into `Music\chek` and runs PM2 through `npx`, so PM2 does not need to be installed globally:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $music=[Environment]::GetFolderPath('MyMusic'); $dest=Join-Path $music 'chek'; $zip=Join-Path $env:TEMP 'chek-update.zip'; $tmp=Join-Path $env:TEMP ('chek-update-' + [guid]::NewGuid()); if(-not (Test-Path $dest)){New-Item -ItemType Directory -Path $dest | Out-Null}; Invoke-WebRequest -Uri 'https://github.com/suijindagoat/chek/archive/refs/heads/main.zip' -OutFile $zip; Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force; $src=(Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1).FullName; Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force; Set-Location $dest; npm install; if($LASTEXITCODE){exit $LASTEXITCODE}; $q=[string][char]34; $node=(Get-Command node).Source; $vbs=Join-Path $dest 'launch-hidden.vbs'; $vbsLines=@('Option Explicit','Dim shell, appDir, nodeExe, entryPoint, command',('Set shell = CreateObject({0}WScript.Shell{0})' -f $q),('appDir = CreateObject({0}Scripting.FileSystemObject{0}).GetParentFolderName(WScript.ScriptFullName)' -f $q),('nodeExe = {0}{1}{0}' -f $q,$node),('entryPoint = appDir & {0}\index.js{0}' -f $q),'shell.CurrentDirectory = appDir','command = Chr(34) & nodeExe & Chr(34) & Chr(32) & Chr(34) & entryPoint & Chr(34)','shell.Run command, 0, False'); Set-Content -LiteralPath $vbs -Value $vbsLines -Encoding ASCII; $desktop=[Environment]::GetFolderPath('Desktop'); $lnk=Join-Path $desktop 'Google Chrome.lnk'; $chromeCandidates=@((Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),'C:\Program Files\Google\Chrome\Application\chrome.exe','C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'); $chrome=$chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1; if(-not $chrome){$chrome=$node}; $wscript=Join-Path $env:WINDIR 'System32\wscript.exe'; $shell=New-Object -ComObject WScript.Shell; $shortcut=$shell.CreateShortcut($lnk); $shortcut.TargetPath=$wscript; $shortcut.Arguments=$q+$vbs+$q; $shortcut.WorkingDirectory=$dest; $shortcut.IconLocation=$chrome+',0'; $shortcut.Description='Google Chrome'; $shortcut.WindowStyle=7; $shortcut.Save(); npx --yes pm2@latest startOrRestart ecosystem.config.cjs; exit $LASTEXITCODE"
```

`npm run pm2:start` runs:

```bat
npx --yes pm2@latest startOrRestart ecosystem.config.cjs
```

Close the terminal and PM2 keeps it running.

PM2 restarts only restart the Node controller. Chrome is launched through Puppeteer with the dedicated `.chrome-profile` profile.

The PM2 config also starts `clipkey-updater`. It checks GitHub every 5 minutes. When the latest commit changes, it downloads the GitHub ZIP, overwrites/appends the files in this folder, runs `npm install`, then restarts only `clipkey-flag`. It does not delete `.chrome-profile`.

The first updater run stores the current GitHub commit as its baseline. New commits after that are applied automatically.

## Files it creates

- `.chrome-profile/` - persistent browser profile, only when `CLIPKEY_PROFILE_MODE=app`.
- `.device-id` - device id used for activation.
- `.github-update-state.json` - last GitHub commit applied by the updater.
