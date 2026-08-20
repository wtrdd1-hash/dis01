# ⚙️ 운영 가이드

## 1. 로컬 개발

```bash
git clone https://github.com/wtrdd1-hash/dis01.git
cd dis01
npm install
cp .env.example .env  # 환경 변수 직접 설정
node src/index.js
```

`.env.example`에는 플레이스홀더만 유지합니다. 실제 토큰·비밀번호·키는 `.env`에만 저장하고 Git에 추가하지 않습니다.

## 2. VPS 배포

```bash
ssh vps-wtrdd
mkdir -p /tmp/dis01-update
chmod 777 /tmp/dis01-update

# 로컬 PowerShell에서:
scp <files> vps-wtrdd:/tmp/dis01-update/

# VPS에서:
sudo -n docker cp /tmp/dis01-update/<file> wtrdd-discord-app:/app/<path>
sudo -n docker exec wtrdd-discord-app chmod 666 /app/<file>
sudo -n docker restart wtrdd-discord-app
```

## 3. 데이터 초기화

```bash
# VPS 컨테이너 안에서 실행
sudo -n docker exec wtrdd-discord-app node /app/scripts/reset_user_data.js
```

## 4. 백업

### 4.1 로컬
```powershell
.\scripts\backup_all.ps1
```
zip 생성 위치: `\.bak\full_YYYYMMDD_HHMMSS\full_backup_*.zip`

### 4.2 VPS
- 도커 mysql → `/home/wtrdd/backups/`
- 자동 6시간 주기 (`backup_engine.js`)
- 컨테이너 안 `backups/` 디렉토리 (`/app/backups/`)

## 5. 환경 변수

`.env` 파일에는 다음이 들어갑니다 (**git 추적 금지**):
- `DISCORD_TOKEN`
- `ADMIN_ID`, `ADMIN_IDS` (콤마 구분)
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
- `CF_API_KEY`, `CF_TUNNEL_TOKEN` (Cloudflare)
- `COOKIE_SECRET`

## 6. 트러블슈팅

### 상태 확인
```bash
# 프로세스 라이브니스: 웹 프로세스가 응답하면 200
curl -fsS http://127.0.0.1:8080/healthz

# 서비스 준비 상태: DB와 Discord 봇이 모두 준비됐을 때만 200
curl -fsS http://127.0.0.1:8080/readyz
```

### 봇이 SIGTERM 후 무한 재시작
```bash
sudo -n docker logs wtrdd-discord-app --tail 30
# 오류 검색 후 src/utils/economyBalancer.js 검증
```

### DB Connection Pool 고갈
```bash
# 5분마다 풀 상태 출력 (이미 모니터링 활성화됨)
grep "DB Pool" /tmp/docker.log
```

### 캐시 미스 폭증
```bash
grep "LiveSync GC" /tmp/docker.log
# hits/misses 비율 점검, 30% 이상이면 TTL 조정 필요
```

### 5초 캐시로 인한 사용자 혼란
- 관리자 명령 후 즉시 새로고침: `liveSync.broadcastUserRefresh(userId)`
- 강제 캐시 무효화: `liveSync.invalidateUser(userId)`
