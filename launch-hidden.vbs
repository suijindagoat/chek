Option Explicit

Dim shell, appDir, nodeExe, entryPoint, command

Set shell = CreateObject("WScript.Shell")
appDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
nodeExe = "C:\nvm4w\nodejs\node.exe"
entryPoint = appDir & "\index.js"

shell.CurrentDirectory = appDir
command = """" & nodeExe & """ """ & entryPoint & """"

' 0 = hidden window, False = do not wait. Chrome launched by Puppeteer remains visible.
shell.Run command, 0, False
