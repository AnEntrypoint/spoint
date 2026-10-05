$names = (Get-Counter '\Process(*)\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples
$ids = (Get-Counter '\Process(*)\ID Process' -ErrorAction SilentlyContinue).CounterSamples
$pidOf = @{}
foreach ($x in $ids) { $pidOf[$x.InstanceName] = [int]$x.CookedValue }
$cores = [Environment]::ProcessorCount
$all = [int](Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$byName = @{}
$rows = @()
foreach ($x in $names) {
  $inst = $x.InstanceName
  if ($inst -eq '_total' -or $inst -eq 'idle') { continue }
  $n = $inst -replace '#\d+$', ''
  if (-not $byName.ContainsKey($n)) { $byName[$n] = 0.0 }
  $byName[$n] += [double]$x.CookedValue / 100.0
  $rows += [pscustomobject]@{ Pid = $pidOf[$inst]; Name = $n; Cores = [double]$x.CookedValue / 100.0 }
}
$top = $byName.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 5 | ForEach-Object { "{0}:{1:N2}" -f $_.Key, $_.Value }
$procs = @()
foreach ($r in ($rows | Sort-Object -Property Cores -Descending | Select-Object -First 5)) {
  $cmd = ''
  if ($r.Pid) {
    $c = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $r.Pid) -ErrorAction SilentlyContinue
    if ($c -and $c.CommandLine) { $cmd = $c.CommandLine; if ($cmd.Length -gt 110) { $cmd = $cmd.Substring(0, 110) } }
  }
  $procs += ("{0}|{1}|{2:N2}|{3}" -f $r.Pid, $r.Name, $r.Cores, ($cmd -replace '[\r\n;|]', ' '))
}
Write-Output ("all={0} cores={1} top={2}" -f $all, $cores, ($top -join ','))
Write-Output ("procs={0}" -f ($procs -join ';'))
