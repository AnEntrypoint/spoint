$e = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine
$s = 0
foreach ($x in $e) { if ($x.Name -match 'engtype_3D') { $s += [double]$x.UtilizationPercentage } }
$all = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='chrome-headless-shell.exe'")
$parent = @{}
foreach ($p in $all) { $parent[[int]$p.ProcessId] = [int]$p.ParentProcessId }
$rootOf = @{}
foreach ($p in $all) {
  $cur = [int]$p.ProcessId
  for ($i = 0; $i -lt 12; $i++) {
    $par = $parent[$cur]
    if ($par -eq $null) { break }
    if (-not $parent.ContainsKey($par)) { break }
    $cur = $par
  }
  $rootOf[[int]$p.ProcessId] = $cur
}
$groups = @{}
foreach ($p in $all) {
  $r = $rootOf[[int]$p.ProcessId]
  if (-not $groups.ContainsKey($r)) { $groups[$r] = @() }
  $groups[$r] += $p
}
$sp = 0; $tr = 0; $us = 0; $ot = 0; $pf = 0
foreach ($r in $groups.Keys) {
  $udd = ''
  foreach ($g in $groups[$r]) {
    if ($g.CommandLine -match '--user-data-dir="([^"]+)"') { $udd = $matches[1]; break }
    if ($g.CommandLine -match '--user-data-dir=(\S+)') { $udd = $matches[1]; break }
  }
  $n = @($groups[$r]).Count
  if ($udd -match 'spoint-cdp-') { $pf += $n }
  elseif ($udd -match 'dev\.train') { $tr += $n }
  elseif ($udd -match '\.gm[\\/]browser') { $sp += $n }
  elseif ($udd -match 'AppData[\\/]Local[\\/]Google[\\/]Chrome[\\/]') { $us += $n }
  elseif ($udd -eq '') { $us += $n }
  else { $ot += $n }
}
$c = [int](Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
Write-Output "gpu3d=$s train=$tr gm=$sp perf=$pf other=$ot user=$us chrome=$($all.Count) cpu=$c ours=$pf"
