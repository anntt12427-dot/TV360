# Fix: chen lai the <style> mo (lan splice truoc lam mat dong nay)
$log = "c:\Users\nguye\Desktop\TV360-TEST\splice-out.txt"
$dir = "c:\Users\nguye\Desktop\TV360-TEST"
"=== FIX STYLE TAG $(Get-Date -Format 'HH:mm:ss') ===" | Out-File $log -Encoding utf8

$path = "$dir\public\index.html"
$html = [System.IO.File]::ReadAllLines($path)

# Neu dong 22 (index 21) chua phai <style> thi chen vao
if ($html.Count -gt 21 -and $html[21] -notmatch '<style>') {
    $out = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt 21; $i++) { $out.Add($html[$i]) }
    $out.Add("<style>")
    for ($i = 21; $i -lt $html.Count; $i++) { $out.Add($html[$i]) }
    $enc = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllLines($path, $out, $enc)
    "DA CHEN <style> vao line 22. Tong dong: $($out.Count)" | Out-File $log -Append -Encoding utf8
} else {
    "Line 22 da la <style> hoac file thay doi -> khong can sua" | Out-File $log -Append -Encoding utf8
}

# Xac minh
$html2 = [System.IO.File]::ReadAllLines($path)
$s = -1; $e = -1
for ($i = 0; $i -lt $html2.Count; $i++) { if ($html2[$i] -match '<style>') { $s = $i; break } }
for ($i = $s + 1; $i -lt $html2.Count; $i++) { if ($html2[$i] -match '</style>') { $e = $i; break } }
"<style> o line $($s+1), </style> o line $($e+1) | CSS trong style: $($e - $s - 1) dong" | Out-File $log -Append -Encoding utf8
"=== DONE ===" | Out-File $log -Append -Encoding utf8
