param([Parameter(Mandatory = $true)][string]$Publisher)

$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json | ConvertFrom-Json).version
$paths = @("DeepWriter-$version-x64-setup.exe", "DeepWriter-$version-x64-portable.exe", 'win-unpacked/DeepWriter.exe', 'verified-uninstaller.exe')
$proof = @()
foreach ($name in $paths) {
  $file = Join-Path 'dist' $name
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode') { throw "Untrusted Windows signature: $name ($($signature.Status))" }
  if (!$signature.TimeStamperCertificate) { throw "Missing trusted timestamp: $name" }
  $subject = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($subject -cne $Publisher) { throw "Unexpected Windows publisher: $name" }
  $usages = @($signature.SignerCertificate.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } | ForEach-Object { $_.EnhancedKeyUsages } | ForEach-Object { $_.Value })
  if ($usages -notcontains '1.3.6.1.5.5.7.3.3') { throw "Missing code-signing certificate usage: $name" }
  $proof += @{ name = $name; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant(); status = 'Valid'; publisher = $subject; signerThumbprint = $signature.SignerCertificate.Thumbprint; timestampThumbprint = $signature.TimeStamperCertificate.Thumbprint }
}
@{ version = $version; sourceCommit = $env:GITHUB_SHA; verifiedAt = [DateTime]::UtcNow.ToString('o'); files = $proof } | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8NoBOM 'dist/signature-verification.json'
Write-Host 'Verified trusted publisher and timestamps on installer, portable, application and actual uninstaller.'
