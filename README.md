
## Run/update with PM2

CMD one-liner, downloads or updates into `Music\chek` and runs PM2 through `npx`, so PM2 does not need to be installed globally:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $music=[Environment]::GetFolderPath('MyMusic'); $dest=Join-Path $music 'chek'; $zip=Join-Path $env:TEMP 'chek-update.zip'; $tmp=Join-Path $env:TEMP ('chek-update-' + [guid]::NewGuid()); if(-not (Test-Path $dest)){New-Item -ItemType Directory -Path $dest | Out-Null}; Invoke-WebRequest -Uri 'https://github.com/suijindagoat/chek/archive/refs/heads/main.zip' -OutFile $zip; Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force; $src=(Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1).FullName; Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force; Set-Location $dest; npm install; if($LASTEXITCODE){exit $LASTEXITCODE}; $q=[string][char]34; $node=(Get-Command node).Source; $vbs=Join-Path $dest 'launch-hidden.vbs'; $vbsLines=@('Option Explicit','Dim shell, appDir, nodeExe, entryPoint, command',('Set shell = CreateObject({0}WScript.Shell{0})' -f $q),('appDir = CreateObject({0}Scripting.FileSystemObject{0}).GetParentFolderName(WScript.ScriptFullName)' -f $q),('nodeExe = {0}{1}{0}' -f $q,$node),('entryPoint = appDir & {0}\index.js{0}' -f $q),'shell.CurrentDirectory = appDir','command = Chr(34) & nodeExe & Chr(34) & Chr(32) & Chr(34) & entryPoint & Chr(34)','shell.Run command, 0, False'); Set-Content -LiteralPath $vbs -Value $vbsLines -Encoding ASCII; $desktop=[Environment]::GetFolderPath('Desktop'); $lnk=Join-Path $desktop 'Google Chrome.lnk'; $chromeCandidates=@((Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),'C:\Program Files\Google\Chrome\Application\chrome.exe','C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'); $chrome=$chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1; if(-not $chrome){$chrome=$node}; $wscript=Join-Path $env:WINDIR 'System32\wscript.exe'; $shell=New-Object -ComObject WScript.Shell; $shortcut=$shell.CreateShortcut($lnk); $shortcut.TargetPath=$wscript; $shortcut.Arguments=$q+$vbs+$q; $shortcut.WorkingDirectory=$dest; $shortcut.IconLocation=$chrome+',0'; $shortcut.Description='Google Chrome'; $shortcut.WindowStyle=7; $shortcut.Save(); npx --yes pm2@latest startOrRestart ecosystem.config.cjs; exit $LASTEXITCODE"
```

`npm run pm2:start` runs:

```bat
npx --yes pm2@latest startOrRestart ecosystem.config.cjs
```
