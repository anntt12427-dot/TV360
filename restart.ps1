# Restart server TV360 qua WMI (detached + an cua so)
$log = "c:\Users\nguye\Desktop\TV360-TEST\restart4-out.txt"
$dir = "c:\Users\nguye\Desktop\TV360-TEST"
"=== RESTART4 $(Get-Date -Format 'HH:mm:ss') ===" | Out-File $log -Encoding utf8

$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -match 'server\.js'
}
foreach ($p in $procs) {
    "KILL node PID $($p.ProcessId): $($p.CommandLine)" | Out-File $log -Append -Encoding utf8
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

$startup = ([wmiclass]"Win32_ProcessStartup").CreateInstance()
$startup.ShowWindow = 0
$res = Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList @(
    '"C:\Program Files\nodejs\node.exe" server.js',
    $dir,
    $startup
)
"WMI Create ReturnCode: $($res.ReturnValue) (0 = thanh cong), PID moi: $($res.ProcessId)" | Out-File $log -Append -Encoding utf8

Start-Sleep -Seconds 6
$conn = netstat -ano | Select-String ':3000' | Select-String 'LISTENING' | Select-Object -First 1
if ($conn) {
    "PORT 3000: $($conn.ToString().Trim())" | Out-File $log -Append -Encoding utf8
} else {
    "CANH BAO: chua co gi listen tren 3000!" | Out-File $log -Append -Encoding utf8
}
"=== DONE ===" | Out-File $log -Append -Encoding utf8
