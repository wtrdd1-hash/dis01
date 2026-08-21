#!/bin/bash
set -euo pipefail
umask 077

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/home/wtrdd/backups/full-backup-$TIMESTAMP"
PROJECT_DIR="/home/wtrdd/discord-bot"
SOURCE_DIR="$PROJECT_DIR"
if [[ -d "$PROJECT_DIR/current/src" ]]; then
  SOURCE_DIR="$PROJECT_DIR/current"
fi

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
mkdir -p "$BACKUP_DIR"

echo "=== 1. MySQL 데이터베이스 전체 덤프 백업 ==="
MYSQL_PWD="$DB_PASSWORD" mysqldump -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" > "$BACKUP_DIR/${DB_NAME}.sql"
echo "✅ MySQL 덤프 완료 ($(du -h "$BACKUP_DIR/${DB_NAME}.sql" | cut -f1))"

echo "=== 2. 프로젝트 소스코드 및 도커 설정 백업 ==="
cd "$SOURCE_DIR"
cp -r src scripts deploy docker-compose.yml Dockerfile .dockerignore package.json package-lock.json README.md "$BACKUP_DIR/" 2>/dev/null || true
cp -r "$PROJECT_DIR/.env" "$PROJECT_DIR/uploads" "$BACKUP_DIR/" 2>/dev/null || true
echo "✅ 도커 및 프로젝트 소스 복사 완료"

echo "=== 3. 통합 압축 아카이브 파일 생성 ==="
cd /home/wtrdd/backups
tar -czf "full-backup-$TIMESTAMP.tar.gz" "full-backup-$TIMESTAMP"
cp "full-backup-$TIMESTAMP.tar.gz" /home/wtrdd/latest_full_backup.tar.gz
echo "✅ 통합 백업 아카이브 생성 완료:"
ls -lh "/home/wtrdd/backups/full-backup-$TIMESTAMP.tar.gz"

echo "=== 4. 현재 가동 중인 도커 컨테이너 상태 저장 ==="
docker ps > "$BACKUP_DIR/docker_containers_status.txt" 2>/dev/null || true

echo "TIMESTAMP:$TIMESTAMP"
