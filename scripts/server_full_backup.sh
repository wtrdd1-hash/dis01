#!/bin/bash
set -e

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/home/wtrdd/backups/full-backup-$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

echo "=== 1. MySQL 데이터베이스 전체 덤프 백업 ==="
mysqldump -h 127.0.0.1 -u account_user -p'Account2026!@#' accountax_db > "$BACKUP_DIR/accountax_db.sql"
echo "✅ MySQL 덤프 완료 ($(du -h "$BACKUP_DIR/accountax_db.sql" | cut -f1))"

echo "=== 2. 프로젝트 소스코드 및 도커 설정 백업 ==="
cd /home/wtrdd/discord-bot
cp -r src scripts deploy docker-compose.yml Dockerfile .dockerignore package.json package-lock.json README.md .env uploads "$BACKUP_DIR/" 2>/dev/null || true
echo "✅ 도커 및 프로젝트 소스 복사 완료"

echo "=== 3. 통합 압축 아카이브 파일 생성 ==="
cd /home/wtrdd/backups
tar -czf "full-backup-$TIMESTAMP.tar.gz" "full-backup-$TIMESTAMP"
cp "full-backup-$TIMESTAMP.tar.gz" /home/wtrdd/latest_full_backup.tar.gz
echo "✅ 통합 백업 아카이브 생성 완료:"
ls -lh "/home/wtrdd/backups/full-backup-$TIMESTAMP.tar.gz"

echo "=== 4. 현재 가동 중인 도커 컨테이너 상태 저장 ==="
sudo docker ps > "$BACKUP_DIR/docker_containers_status.txt" 2>/dev/null || true

echo "TIMESTAMP:$TIMESTAMP"
