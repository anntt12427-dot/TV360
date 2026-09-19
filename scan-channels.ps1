$c = irm http://localhost:3000/api/channels?type=tv
$bad = @()
$i = 0
foreach($ch in $c.channels){
    $i++
    try {
        $u = "http://localhost:3000/api/resolve?url=" + [uri]::EscapeDataString($ch.url)
        $r = irm $u -TimeoutSec 25
        if(-not $r.ok){
            $bad += [pscustomobject]@{name=$ch.name; group=$ch.group; err=[string]$r.error}
        }
    } catch {
        $bad += [pscustomobject]@{name=$ch.name; group=$ch.group; err=$_.Exception.Message}
    }
    if($i % 50 -eq 0){ Write-Host "DA QUET $i/$($c.channels.Count)" }
}
Write-Output "TONG: $($c.channels.Count) - LOI: $($bad.Count)"
$bad | Format-Table -AutoSize | Out-String -Width 200 | Write-Output
