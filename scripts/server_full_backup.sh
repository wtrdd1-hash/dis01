#!/bin/bash
# ==============================================================================
# 🛡️ WTRD Duck Economy Docker & MySQL Full Automated Backup System
# ==============================================================================
set -euo pipefail
umask 077

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUPS_ROOT="/home/wtrdd/backups"
BACKUP_DIR="$BACKUPS_ROOT/full-backup-$TIMESTAMP"
PROJECT_DIR="/home/wtrdd/discord-bot"
SOURCE_DIR="$PROJECT_DIR"
if [[ -d "$PROJECT_DIR/current/src" ]]; then
  SOURCE_DIR="$PROJECT_DIR/current"
fi

mkdir -p "$BACKUPS_ROOT" "$BACKUP_DIR"

echo "=== [1/5] 환경 변수 및 설정 검증 ==="
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo "❌ $PROJECT_DIR/.env 파일이 없습니다."
  exit 1
fi

set -a
# shellcheck disable=SC1091
. "$PROJECT_DIR/.env"
set +a

: "${DB_USER:?DB_USER가 필요합니다}"
: "${DB_PASSWORD:?DB_PASSWORD가 필요합니다}"
: "${DB_NAME:?DB_NAME이 필요합니다}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"

echo "=== [2/5] MySQL 무중단 트랜잭션 덤프 실행 ==="
MYSQL_PWD="$DB_PASSWORD" mysqldump \
  -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
  --single-transaction \
  --quick \
  --routines \
  --triggers \
  --events \
  --default-character-set=utf8mb4 \
  "$DB_NAME" > "$BACKUP_DIR/${DB_NAME}.sql"

DB_DUMP_SIZE=$(du -h "$BACKUP_DIR/${DB_NAME}.sql" | cut -f1)
echo "✅ MySQL 덤프 완료 (크기: $DB_DUMP_SIZE)"

echo "=== [3/5] 도커 설정, 볼륨 및 소스코드 스냅샷 ==="
cd "$SOURCE_DIR"
cp -r src scripts deploy docker-compose.yml Dockerfile .dockerignore package.json package-lock.json README.md "$BACKUP_DIR/" 2>/dev/null || true
cp -r "$PROJECT_DIR/.env" "$BACKUP_DIR/" 2>/dev/null || true

if [[ -d "$PROJECT_DIR/uploads" ]]; then
  cp -r "$PROJECT_DIR/uploads" "$BACKUP_DIR/" 2>/dev/null || true
fi

# 도커 메타데이터 저장
docker ps -a --no-trunc > "$BACKUP_DIR/docker_containers.txt" 2>/dev/null || true
docker images --no-trunc > "$BACKUP_DIR/docker_images.txt" 2>/dev/null || true

echo "=== [4/5] 압축 아카이브 생성 및 무결성 검증 ==="
ARCHIVE_PATH="$BACKUPS_ROOT/full-backup-$TIMESTAMP.tar.gz"
tar -czf "$ARCHIVE_PATH" -C "$BACKUPS_ROOT" "full-backup-$TIMESTAMP"
rm -rf "$BACKUP_DIR"

# 무결성 검증
tar -tzf "$ARCHIVE_PATH" > /dev/null
ln -sfn "$ARCHIVE_PATH" "$BACKUPS_ROOT/latest_full_backup.tar.gz"

ARCHIVE_SIZE=$(du -h "$ARCHIVE_PATH" | cut -f1)
echo "✅ 무결성 검증 완료! 아카이브: $ARCHIVE_PATH ($ARCHIVE_SIZE)"

echo "=== [5/5] 백업 보관주기(Retention) 정리 & 디스크 관리 ==="
# 최근 14개(약 7일치) 보관 후 이전 백업 자동 삭제
PURGED_COUNT=0
for old_backup in $(find "$BACKUPS_ROOT" -maxdepth 1 -name "full-backup-*.tar.gz" -type f -printf '%T@ %p\n' | sort -nr | tail -n +15 | cut -d' ' -f2-); do
  rm -f "$old_backup"
  PURGED_COUNT=$((PURGED_COUNT + 1))
done
echo "🧹 보관 주기 초과 백업 $PURGED_COUNT개 정리 완료"

DISK_FREE=$(df -h "$BACKUPS_ROOT" | awk 'NR==2 {print $4}')
echo "💾 남은 디스크 여유 공간: $DISK_FREE"

# 디스코드 웹훅 알림 (설정된 경우)
WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-${DISCORD_BACKUP_WEBHOOK_URL:-}}"
if [[ -n "$WEBHOOK_URL" ]]; then
  PAYLOAD=$(cat <<EOF
{
  "embeds": [{
    "title": "🛡️ [백업 시스템] 도커 & DB 자동 백업 완료",
    "color": 3066993,
    "fields": [
      { "name": "백업 파일", "value": "\`full-backup-$TIMESTAMP.tar.gz\`", "inline": true },
      { "name": "압축 크기", "value": "$ARCHIVE_SIZE", "inline": true },
      { "name": "디스크 여유", "value": "$DISK_FREE", "inline": true }
    ],
    "footer": { "text": "월덕 자동 백업 시스템 | 타임스탬프: $TIMESTAMP" }
  }]
}
EOF
)
  curl -s -H "Content-Type: application/json" -d "$PAYLOAD" "$WEBHOOK_URL" > /dev/null || true
fi

echo "TIMESTAMP:$TIMESTAMP"
echo "BACKUP_COMPLETED_SUCCESSFULLY"
