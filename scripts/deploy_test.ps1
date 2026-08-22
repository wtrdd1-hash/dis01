# PowerShell Deployment Script for TEST Environment (Immutable Build & Gate)
$ErrorActionPreference = "Stop"

$BUILD_TAG = "test-" + (Get-Date -Format "yyyyMMddHHmmss")
Write-Host "════════════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "🚀 [TEST] 불변 이미지 빌드 및 배포 파이프라인 시작 (태그: $BUILD_TAG)" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════════════════════════════" -ForegroundColor Cyan

# 1. 로컬 테스트 검증
Write-Host "🧪 [1/4] 로컬 테스트 스위트 검증 중 (npm test)..." -ForegroundColor Yellow
npm.cmd test
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 테스트 실패! 배포가 중단되었습니다." -ForegroundColor Red
    exit 1
}
Write-Host "✅ 모든 테스트 통과!" -ForegroundColor Green

# 2. 아카이브 생성 및 전송
$TARGET_HOST = if ($env:TEST_HOST) { $env:TEST_HOST } else { "192.168.100.1" }
Write-Host "`n📦 [2/4] 소스 아카이브 생성 및 테스트 서버($TARGET_HOST) 전송 중..." -ForegroundColor Yellow
$tempTar = "$env:TEMP\discord_bot_test_deploy.tar.gz"
tar --exclude='node_modules' --exclude='.git' --exclude='logs' --exclude='backups' --exclude='uploads' --exclude='.env*' --exclude='scratch' --exclude='handoff' --exclude='.user_uploaded' --exclude='*.docx' --exclude='~$*' --exclude='~WRL*' -czf $tempTar -C (Get-Location) .
if ($LASTEXITCODE -ne 0) {
    throw "배포 아카이브 생성에 실패했습니다."
}

scp -P 34567 -i C:\Users\sds\.ssh\id_ed25519 $tempTar wtrdd@${TARGET_HOST}:/tmp/test_deploy.tar.gz
if ($LASTEXITCODE -ne 0) {
    throw "테스트 서버로 배포 아카이브를 전송하지 못했습니다."
}
Remove-Item -Force $tempTar -ErrorAction SilentlyContinue

# 3. 서버에서 불변 도커 이미지 빌드 및 컨테이너 갱신
Write-Host "`n🏗️ [3/4] 원격 서버에서 불변 이미지 빌드 (docker build) 및 컨테이너 기동..." -ForegroundColor Yellow
$candidateProbe = "Promise.all(['readyz','healthz'].map((path)=>fetch('http://127.0.0.1:18085/'+path).then((res)=>res.json()))).then(([ready,health])=>process.exit(ready.ok?0:1)).catch(()=>process.exit(1));"
$candidateProbeBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($candidateProbe))
$remoteCmd = @"
set -e
mkdir -p /home/wtrdd/discord-bot-test/releases/$BUILD_TAG
tar --warning=no-unknown-keyword -xzf /tmp/test_deploy.tar.gz -C /home/wtrdd/discord-bot-test/releases/$BUILD_TAG 2>/dev/null || tar -xzf /tmp/test_deploy.tar.gz -C /home/wtrdd/discord-bot-test/releases/$BUILD_TAG
rm -f /tmp/test_deploy.tar.gz
umask 077
grep -E '^(ADMIN_ID|ADMIN_IDS|COOKIE_SECRET|DB_HOST|DB_NAME|DB_PASSWORD|DB_PORT|DB_USER|DISCORD_CLIENT_ID|DISCORD_CLIENT_SECRET|DISCORD_REDIRECT_URI|REDIRECT_URI|SECURITY_WHITELIST_IPS)=' /home/wtrdd/discord-bot-test/.env > /home/wtrdd/discord-bot-test/.env.runtime.tmp
test -s /home/wtrdd/discord-bot-test/.env.runtime.tmp
mv /home/wtrdd/discord-bot-test/.env.runtime.tmp /home/wtrdd/discord-bot-test/.env.runtime
mkdir -p /home/wtrdd/discord-bot-test/backups /home/wtrdd/discord-bot-test/uploads /home/wtrdd/discord-bot-test/logs
cd /home/wtrdd/discord-bot-test/releases/$BUILD_TAG
docker build -t discord-bot-app:$BUILD_TAG -t discord-bot-app:test-latest .
docker run --rm discord-bot-app:$BUILD_TAG npm test
TEST_DATA_ROOT=/home/wtrdd/discord-bot-test docker compose -f docker-compose.test.yml --project-name wtrdd-test config -q

# Compose 프로젝트 컨테이너를 새 불변 이미지로 교체한다.
docker rm -f wtrdd-test-app >/dev/null 2>&1 || true
TEST_DATA_ROOT=/home/wtrdd/discord-bot-test docker compose -f docker-compose.test.yml --project-name wtrdd-test up -d --force-recreate --remove-orphans
ln -sfn /home/wtrdd/discord-bot-test/releases/$BUILD_TAG /home/wtrdd/discord-bot-test/current
"@

ssh -p 34567 -i C:\Users\sds\.ssh\id_ed25519 wtrdd@${TARGET_HOST} "$remoteCmd"
if ($LASTEXITCODE -ne 0) {
    throw "원격 테스트 이미지 빌드 또는 컨테이너 기동에 실패했습니다."
}

# 4. /readyz 헬스체크 게이트 검증 (최대 30초 대기)
Write-Host "`n🩺 [4/4] /readyz 헬스체크 게이트 검증 중..." -ForegroundColor Yellow
$maxRetries = 15
$success = $false
for ($i = 1; $i -le $maxRetries; $i++) {
    Start-Sleep -Seconds 2
    try {
        $resp = ssh -p 34567 -i C:\Users\sds\.ssh\id_ed25519 wtrdd@${TARGET_HOST} "curl -s -f http://127.0.0.1:8085/readyz"
        if (($LASTEXITCODE -eq 0) -and ($resp -match '"ok":\s*true') -and ($resp -match '"botRequired":\s*false')) {
            Write-Host "✅ 헬스체크 통과! ($resp)" -ForegroundColor Green
            $success = $true
            break
        }
    } catch {
        Write-Host "⏳ 헬스체크 대기 중 ($i/$maxRetries)..." -ForegroundColor Gray
    }
}

if (-not $success) {
    Write-Host "❌ 헬스체크 실패! 서비스가 정상 기동되지 않았습니다." -ForegroundColor Red
    exit 1
}

$health = ssh -p 34567 -i C:\Users\sds\.ssh\id_ed25519 wtrdd@${TARGET_HOST} "curl -s -f http://127.0.0.1:8085/healthz"
if (($LASTEXITCODE -ne 0) -or ($health -notmatch '"bot":\s*false')) {
    Write-Host "❌ 테스트 컨테이너에서 Discord 봇이 실행 중입니다. 격리 검증 실패." -ForegroundColor Red
    exit 1
}
Write-Host "✅ 테스트 환경은 웹 전용으로 격리되었습니다. ($health)" -ForegroundColor Green

Write-Host "`n🎉 [TEST] 배포 성공 및 승격 완료!" -ForegroundColor Green
Write-Host "🌐 테스트 주소: https://test.easy-scraping.com" -ForegroundColor Cyan
