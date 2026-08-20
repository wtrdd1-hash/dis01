# 📜 변경 이력

## v2026.08.20 — 경제 안정화 + UI 모더니제이션 + GitHub 푸시

### 🐛 보안 수정 (CRITICAL)
- P2P 강제집행 이중지급 방지 (이미 FIX됨)
- 재산세 /144 → /52,560 분할 (연간 정상화)
- `forcedRegimeIndex=5 (SLUMP)` → `7 (LIQUIDITY)` 인덱스 오류 수정
- `work.js` `username` ReferenceError 수정
- `.env` GitHub 추적 차단 확인

### ⚡ 성능 개선
- DB Connection Pool 튜닝 (limit 25, keepAlive, 5분 모니터링)
- liveSync 메모리 캐시 + 60s GC (snapshot 5s, tax/loan 30s)
- socket.io 핑 최적화 (60s timeout / 25s interval)
- 자동채굴 Lv50 상한 + 15→3 (수익 80%↓)

### 🎨 UI 모더니제이션
- `dashboard-ux.css` 신규 (368 라인)
- 자산 카드 글래스모피즘 + 색상별 glow
- admin 통계 카드 통일 디자인
- 송금 버튼 강조 + 자산 비율 바 그라데이션

### 📝 문서 작성
- `docs/SYSTEM_ARCHITECTURE.md` — 종합 시스템 설계
- `docs/BOT_COMMANDS.md` — 모든 명령어 가이드
- `docs/OPERATIONS.md` — 로컬 + VPS 운영
- `docs/SQL_LOCKDOWN_POLICY.md` — 백업 정책
- `docs/README.md` — 문서 색인

### 🛠 도구
- `scripts/reset_user_data.js` — 유저 데이터 초기화 (관리자 보존)

### 🔓 SQL 차단
- `.gitignore`에 `backups/`, `*.sql`, `*.sql.gz`, `*.dump` 강화
- 로컬 백업은 `\.bak\` zip 으로 분리 보관

---

## 이전 버전
(향후 추가 예정)
