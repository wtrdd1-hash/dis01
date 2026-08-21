param(
    [string]$BaseUrl = 'https://test.easy-scraping.com'
)

$ErrorActionPreference = 'Stop'

function Invoke-QaProbe {
    param(
        [string]$Method,
        [string]$Path,
        [hashtable]$Headers = @{},
        [string]$Body = $null,
        [string]$ContentType = $null
    )

    $params = @{
        Uri = "$BaseUrl$Path"
        Method = $Method
        Headers = $Headers
        MaximumRedirection = 0
        SkipHttpErrorCheck = $true
        TimeoutSec = 20
    }
    if ($null -ne $Body) { $params.Body = $Body }
    if ($ContentType) { $params.ContentType = $ContentType }

    try {
        $response = Invoke-WebRequest @params
        $preview = [string]$response.Content
        $preview = ($preview -replace '[\r\n|]+', ' ').Trim()
        if ($preview.Length -gt 180) { $preview = $preview.Substring(0, 180) }
        [pscustomobject]@{
            Method = $Method
            Path = $Path
            Status = [int]$response.StatusCode
            Type = [string]$response.Headers['Content-Type']
            ACAO = [string]$response.Headers['Access-Control-Allow-Origin']
            Location = [string]$response.Headers['Location']
            Preview = $preview
        }
    } catch {
        [pscustomobject]@{
            Method = $Method
            Path = $Path
            Status = 'ERR'
            Type = ''
            ACAO = ''
            Location = ''
            Preview = $_.Exception.Message
        }
    }
}

$nonce = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$results = @()
$results += Invoke-QaProbe GET "/?qa_security=$nonce" @{ Origin = 'https://evil.invalid'; 'Cache-Control' = 'no-cache' }
$results += Invoke-QaProbe TRACE '/'
$results += Invoke-QaProbe OPTIONS '/api/shop/buy' @{ Origin = 'https://evil.invalid'; 'Access-Control-Request-Method' = 'POST' }
$results += Invoke-QaProbe POST '/api/shop/buy' @{} '{}' 'application/json'
$results += Invoke-QaProbe POST '/api/lotto/buy' @{} '{}' 'application/json'
$results += Invoke-QaProbe POST '/api/shop/megaphone' @{} '{}' 'application/json'
$results += Invoke-QaProbe GET '/api/admin/logs/access'
$results += Invoke-QaProbe GET '/api/admin/inquiries'
$results += Invoke-QaProbe GET '/api/admin/spending/catalog'
$results += Invoke-QaProbe GET '/api/user/me'
$results += Invoke-QaProbe GET '/api/leaderboard?limit=1%20OR%201%3D1--'
$results += Invoke-QaProbe GET '/auth/guide?qa=%3Cscript%3Ealert(1)%3C%2Fscript%3E'

foreach ($path in @(
    '/.env', '/.git/config', '/package.json', '/package-lock.json',
    '/docker-compose.yml', '/src/config/config.js', '/server-status',
    '/metrics', '/debug', '/debug/pprof',
    '/static/..%2f..%2f.env', '/static/%2e%2e/%2e%2e/.env'
)) {
    $results += Invoke-QaProbe GET $path
}

$results | ForEach-Object {
    $preview = ([string]$_.Preview -replace '[\r\n|]+', ' ')
    Write-Output ("$($_.Method)|$($_.Path)|$($_.Status)|$($_.Type)|ACAO=$($_.ACAO)|LOC=$($_.Location)|$preview")
}

$qaHeaderResponse = Invoke-WebRequest -Uri "$BaseUrl/?qa_headers=$nonce" -Headers @{ 'Cache-Control' = 'no-cache' } -SkipHttpErrorCheck -TimeoutSec 20
Write-Output '=== SECURITY HEADERS ==='
foreach ($name in @(
    'Cache-Control', 'Strict-Transport-Security', 'Content-Security-Policy',
    'X-Frame-Options', 'X-Content-Type-Options', 'Cross-Origin-Opener-Policy',
    'Referrer-Policy', 'Permissions-Policy', 'Server', 'X-Powered-By'
)) {
    Write-Output ("$name=$([string]$qaHeaderResponse.Headers[$name])")
}

try {
    $qaHttpResponse = Invoke-WebRequest -Uri 'http://test.easy-scraping.com/' -MaximumRedirection 0 -TimeoutSec 20
    Write-Output "HTTP_REDIRECT=$([int]$qaHttpResponse.StatusCode)|$([string]$qaHttpResponse.Headers['Location'])"
} catch {
    $qaHttpStatus = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'ERR' }
    $qaHttpLocation = if ($_.Exception.Response) { [string]$_.Exception.Response.Headers.Location } else { '' }
    Write-Output "HTTP_REDIRECT=$qaHttpStatus|$qaHttpLocation"
}
