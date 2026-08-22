#!/bin/bash
# ==============================================================================
# 🚨 WTRD Duck Economy One-Click Restore / Rollback Tool
# ==============================================================================
set -euo pipefail
umask 077

if [[ $# -lt 1 ]]; then
  echo "사용법: $0 <백업파일_경로.tar.gz> [--db-only]"
  echo "예시: $0 /home/wtrdd/backups/full-backup-20260822-202842.tar.gz"
  exit 1
fi

ARCHIVE_PATH="$1"
DB_ONLY="${2:-}"

if [[ ! -f "$ARCHIVE_PATH" ]]; then
  echo "❌ 백업 아카이브를 찾을 수 없습니다: $ARCHIVE_PATH"
  exit 1
fi

echo "🔍 1. 백업 아카이브 무결성 검증 중..."
tar -tzf "$ARCHIVE_PATH" > /dev/null
echo "✅ 아카이브 무결성 확인 완료."

TEMP_RESTORE_DIR=$(mktemp -d /tmp/restore-XXXXXX)
cleanup() { rm -rf "$TEMP_RESTORE_DIR"; }
trap cleanup EXIT

echo "📦 2. 백업 아카이브 압축 해제 중..."
tar -xzf "$ARCHIVE_PATH" -C "$TEMP_RESTORE_DIR"
EXTRACTED_DIR=$(find "$TEMP_RESTORE_DIR" -maxdepth 1 -mindepth 1 -type d | head -n 1)

PROJECT_DIR="/home/wtrdd/discord-bot"
set -a
. "$PROJECT_DIR/.env"
set +a

: "${DB_USER:?DB_USER가 필요합니다}"
: "${DB_PASSWORD:?DB_PASSWORD가 필요합니다}"
: "${DB_NAME:?DB_NAME이 필요합니다}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"

SQL_DUMP="$EXTRACTED_DIR/${DB_NAME}.sql"
if [[ ! -f "$SQL_DUMP" ]]; then
  echo "❌ 아카이브 내에 $DB_NAME.sql 파일이 존재하지 않습니다."
  exit 1
fi

echo "⚠️ [주의] $DB_NAME 데이터베이스를 $SQL_DUMP 데이터로 덮어씌웁니다."
echo "복원을 진행하려면 'RESTORE'를 입력하세요:"
read -r CONFIRM
if [[ "$CONFIRM" != "RESTORE" ]]; then
  echo "🚫 복원 작업이 취소되었습니다."
  exit 0
fi

echo "🔄 3. MySQL 데이터베이스 복원 시작..."
MYSQL_PWD="$DB_PASSWORD" mysql \
  -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
  "$DB_NAME" < "$SQL_DUMP"
echo "✅ MySQL 데이터베이스 복원 완료!"

if [[ "$DB_ONLY" != "--db-only" ]]; then
  echo "🔄 4. 도커 컨테이너 재기동 및 캐시 정리..."
  cd "$PROJECT_DIR"
  docker compose restart wtrdd-discord-app || docker restart wtrdd-discord-app
  echo "✅ 도커 컨테이너 재시작 완료!"
fi

echo "🎉 복원 작업이 성공적으로 완료되었습니다!"
