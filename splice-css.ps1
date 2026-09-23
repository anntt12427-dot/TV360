# Splice new-style.css vao index.html (thay khoi <style>...trong...</style>)
# Khoi style cu: tu dong co "<style>" den dong truoc "</style>"
$log = "c:\Users\nguye\Desktop\TV360-TEST\splice-out.txt"
$dir = "c:\Users\nguye\Desktop\TV360-TEST"
"=== SPLICE $(Get-Date -Format 'HH:mm:ss') ===" | Out-File $log -Encoding utf8

$html = [System.IO.File]::ReadAllLines("$dir\public\index.html")
$css  = [System.IO.File]::ReadAllLines("$dir\new-style.css")

$styleStart = -1
$styleEnd = -1
for ($i = 0; $i -lt $html.Count; $i++) {
    if ($html[$i] -match '<style>') { $styleStart = $i; break }
}
for ($i = $styleStart + 1; $i -lt $html.Count; $i++) {
    if ($html[$i] -match '</style>') { $styleEnd = $i; break }
}
"styleStart=$($styleStart+1), styleEnd=$($styleEnd+1) (1-based)" | Out-File $log -Append -Encoding utf8
if ($styleStart -lt 0 -or $styleEnd -le $styleStart) {
    "KHONG TIM THAY khoi style -> DUNG" | Out-File $log -Append -Encoding utf8
    exit 1
}

$out = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $styleStart; $i++) { $out.Add($html[$i]) }
for ($i = 0; $i -lt $css.Count; $i++) { $out.Add($css[$i]) }
for ($i = $styleEnd; $i -lt $html.Count; $i++) { $out.Add($html[$i]) }

$enc = New-Object System.Text.UTF8Encoding($true)  # giu BOM
[System.IO.File]::WriteAllLines("$dir\public\index.html", $out, $enc)
"OK: index.html moi co $($out.Count) dong (style cu $($styleEnd - $styleStart - 1) dong -> style moi $($css.Count) dong)" | Out-File $log -Append -Encoding utf8
"=== DONE ===" | Out-File $log -Append -Encoding utf8
