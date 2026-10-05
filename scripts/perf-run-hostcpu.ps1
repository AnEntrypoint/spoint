$s = (Get-Counter '\Process(*)\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples
$cores = [Environment]::ProcessorCount
$all = [int](Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$byName = @{}
foreach ($x in $s) {
  $n = $x.InstanceName -replace '#\d+$', ''
  if ($n -eq '_total' -or $n -eq 'idle') { continue }
  if (-not $byName.ContainsKey($n)) { $byName[$n] = 0.0 }
  $byName[$n] += [double]$x.CookedValue / 100.0
}
$top = $byName.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 5 | ForEach-Object { "{0}:{1:N2}" -f $_.Key, $_.Value }
Write-Output ("all={0} cores={1} top={2}" -f $all, $cores, ($top -join ','))
