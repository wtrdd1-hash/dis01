# Production deployment: backup -> immutable candidate -> controlled switch -> rollback gate.
$ErrorActionPreference = "Stop"

$BuildTag = "prod-" + (Get-Date -Format "yyyyMMddHHmmss")
$SshTarget = "wtrdd@192.168.100.1"
$SshKey = "C:\Users\sds\.ssh\id_ed25519"
$SshPort = 34567

Write-Host "[PROD] Safe deployment start: $BuildTag" -ForegroundColor Yellow

Write-Host "[1/5] Running local test suite..." -ForegroundColor Yellow
npm.cmd test
if ($LASTEXITCODE -ne 0) { throw "Local test suite failed." }

Write-Host "[2/5] Creating and transferring immutable source archive..." -ForegroundColor Yellow
$TempTar = Join-Path $env:TEMP "discord_bot_prod_deploy.tar.gz"
tar --exclude='node_modules' --exclude='.git' --exclude='logs' --exclude='backups' --exclude='uploads' --exclude='.env*' --exclude='scratch' --exclude='*.docx' --exclude='~$*' --exclude='~WRL*' --exclude='handoff' --exclude='.user_uploaded' -czf $TempTar -C (Get-Location) .
if ($LASTEXITCODE -ne 0) { throw "Could not create production archive." }

try {
    scp -P $SshPort -i $SshKey $TempTar "${SshTarget}:/tmp/prod_deploy.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw "Could not transfer production archive." }
} finally {
    Remove-Item -LiteralPath $TempTar -Force -ErrorAction SilentlyContinue
}

$CandidateProbe = @'
Promise.all([
  fetch('http://127.0.0.1:18070/readyz').then((response) => response.json()),
  fetch('http://127.0.0.1:18070/healthz').then((response) => response.json()),
  fetch('http://127.0.0.1:18070/api/announcements/popup').then((response) => response.json())
]).then(([ready, health, popup]) => {
  const passed = ready.ok === true && ready.db === true && ready.bot === false &&
    ready.botRequired === false && health.ok === true && health.bot === false && popup.success === true;
  process.exit(passed ? 0 : 1);
}).catch(() => process.exit(1));
'@
$CandidateProbeBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($CandidateProbe))

$RemoteTemplate = @'
set -euo pipefail
DATA_ROOT=/home/wtrdd/discord-bot
RELEASE_ROOT=/home/wtrdd/discord-bot-releases
BUILD_TAG=__BUILD_TAG__
RELEASE_DIR="$RELEASE_ROOT/$BUILD_TAG"
CANDIDATE=wtrdd-prod-candidate
CANDIDATE_PROBE=__CANDIDATE_PROBE__

mkdir -p "$RELEASE_DIR" "$DATA_ROOT/backups" "$DATA_ROOT/uploads" "$DATA_ROOT/logs"
tar --warning=no-unknown-keyword -xzf /tmp/prod_deploy.tar.gz -C "$RELEASE_DIR" 2>/dev/null || tar -xzf /tmp/prod_deploy.tar.gz -C "$RELEASE_DIR"
rm -f /tmp/prod_deploy.tar.gz
test -f "$RELEASE_DIR/Dockerfile"
test -f "$RELEASE_DIR/docker-compose.yml"
test -f "$DATA_ROOT/.env"

# Ensure PORT=8070 in production .env
if grep -q '^PORT=' "$DATA_ROOT/.env"; then
  sed -i 's/^PORT=.*/PORT=8070/' "$DATA_ROOT/.env"
else
  echo 'PORT=8070' >> "$DATA_ROOT/.env"
fi

# Sync nginx proxy configuration
cp -f "$RELEASE_DIR/deploy/nginx/default.conf" "$DATA_ROOT/deploy/nginx/default.conf" 2>/dev/null || true
docker exec wtrdd-edge-proxy nginx -s reload 2>/dev/null || true

echo '[3/5] Creating verified production backup...'
bash "$RELEASE_DIR/scripts/server_full_backup.sh"
test -s /home/wtrdd/latest_full_backup.tar.gz
set -a
. "$DATA_ROOT/.env"
set +a
latest_backup_dir=$(find /home/wtrdd/backups -maxdepth 1 -type d -name 'full-backup-*' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)
test -n "$latest_backup_dir"
test -s "$latest_backup_dir/$DB_NAME.sql"
backup_archive=$(readlink -f /home/wtrdd/latest_full_backup.tar.gz)

current_image=$(docker inspect -f '{{.Image}}' wtrdd-discord-app)
rollback_tag="discord-bot-app:rollback-$BUILD_TAG"
docker tag "$current_image" "$rollback_tag"

echo '[4/5] Building and validating isolated production candidate...'
cd "$RELEASE_DIR"
docker build -t "discord-bot-app:$BUILD_TAG" .
docker run --rm "discord-bot-app:$BUILD_TAG" npm test
PROD_DATA_ROOT="$DATA_ROOT" docker compose --env-file "$DATA_ROOT/.env" -f docker-compose.yml --project-name discord-bot config -q

docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true
cleanup_candidate() { docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true; }
trap cleanup_candidate EXIT
docker run -d --name "$CANDIDATE" --network host --init \
  --env-file "$DATA_ROOT/.env" \
  --env DB_HOST --env DB_PORT --env DB_USER --env DB_PASSWORD --env DB_NAME \
  --env NODE_ENV=production --env PROCESS_TYPE=web --env PORT=18070 --env TZ=Asia/Seoul \
  --env NODE_OPTIONS=--max-old-space-size=768 \
  --user 1001:1001 --read-only \
  --tmpfs /tmp:size=96m,mode=1777,noexec,nosuid,nodev \
  --volume "$DATA_ROOT/backups:/app/backups" \
  --volume "$DATA_ROOT/uploads:/app/uploads" \
  --volume "$DATA_ROOT/logs:/app/logs" \
  --memory 1g --cpus 2 --pids-limit 256 \
  --security-opt no-new-privileges:true --cap-drop ALL \
  "discord-bot-app:$BUILD_TAG" >/dev/null

candidate_ready=0
for attempt in $(seq 1 25); do
  if [[ "$(docker inspect -f '{{.State.Running}}' "$CANDIDATE")" != true ]]; then
    break
  fi
  if echo "$CANDIDATE_PROBE" | base64 -d | docker exec -i "$CANDIDATE" node; then
    candidate_ready=1
    break
  fi
  sleep 2
done
if [[ "$candidate_ready" != 1 ]]; then
  docker logs --tail 160 "$CANDIDATE" >&2 || true
  exit 1
fi
cleanup_candidate
trap - EXIT

docker tag "discord-bot-app:$BUILD_TAG" discord-bot-app:latest

echo '[5/5] Switching production app with automatic rollback gate...'
switch_app() {
  PROD_DATA_ROOT="$DATA_ROOT" docker compose --env-file "$DATA_ROOT/.env" -f "$RELEASE_DIR/docker-compose.yml" --project-name discord-bot up -d --no-deps --force-recreate app
}
switch_app

production_ready=0
for attempt in $(seq 1 35); do
  if ready_json=$(curl -fsS http://127.0.0.1:8070/readyz 2>/dev/null); then
    if echo "$ready_json" | grep -q '"ok":true' && echo "$ready_json" | grep -q '"bot":true' && echo "$ready_json" | grep -q '"botRequired":true'; then
      production_ready=1
      break
    fi
  fi
  sleep 2
done

if [[ "$production_ready" != 1 ]]; then
  echo 'New production container failed readiness; rolling back image.' >&2
  docker logs --tail 220 wtrdd-discord-app >&2 || true
  docker tag "$rollback_tag" discord-bot-app:latest
  switch_app
  rollback_ready=0
  for attempt in $(seq 1 35); do
    if curl -fsS http://127.0.0.1:8070/readyz 2>/dev/null | grep -q '"ok":true'; then
      rollback_ready=1
      break
    fi
    sleep 2
  done
  if [[ "$rollback_ready" != 1 ]]; then
    echo 'ROLLBACK_RESULT=FAILED' >&2
  else
    echo 'ROLLBACK_RESULT=PASS' >&2
  fi
  exit 1
fi

ln -sfn "$RELEASE_DIR" "$DATA_ROOT/current"
cp "$RELEASE_DIR/docker-compose.yml" "$DATA_ROOT/docker-compose.yml"
container_image=$(docker inspect -f '{{.Image}}' wtrdd-discord-app)
container_started=$(docker inspect -f '{{.State.StartedAt}}' wtrdd-discord-app)
echo "BACKUP_VERIFIED=$backup_archive"
echo "ROLLBACK_IMAGE=$rollback_tag"
echo "PRODUCTION_IMAGE=$container_image"
echo "PRODUCTION_STARTED=$container_started"
echo "DEPLOY_RESULT=PASS TAG=$BUILD_TAG"
'@

$RemoteScript = $RemoteTemplate.Replace('__BUILD_TAG__', $BuildTag).Replace('__CANDIDATE_PROBE__', $CandidateProbeBase64)
$RemoteScriptBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($RemoteScript))

Write-Host "[3/5] Running backup, candidate, and production switch gates..." -ForegroundColor Yellow
$RemoteOutput = ssh -p $SshPort -i $SshKey $SshTarget "echo $RemoteScriptBase64 | base64 -d | bash"
if ($LASTEXITCODE -ne 0) { throw "Remote production deployment failed or rolled back." }
$RemoteOutput | ForEach-Object { Write-Host $_ }
if (($RemoteOutput -join "`n") -notmatch 'DEPLOY_RESULT=PASS') { throw "Production deploy marker was not returned." }

Write-Host "[5/5] Verifying public HTTPS readiness..." -ForegroundColor Yellow
$PublicReady = curl.exe -fsS https://easy-scraping.com/readyz
if ($LASTEXITCODE -ne 0) { throw "Public production readiness endpoint failed." }
$PublicJson = $PublicReady | ConvertFrom-Json
if (-not $PublicJson.ok -or -not $PublicJson.bot -or -not $PublicJson.botRequired) {
    throw "Public production readiness payload did not confirm web, DB, and Discord bot readiness."
}

Write-Host "[PROD] Deployment completed: $BuildTag" -ForegroundColor Green
Write-Host "Production URL: https://easy-scraping.com" -ForegroundColor Cyan
