# 🏦 월덕 가상 경제 — 시스템 아키텍처 (v2026.08)

> **목표**: 실제 경제처럼 작동하며, 차익거래 기회를 차단하고, 자동 균형을 유지하는
> 디스코드 가상 경제 시스템.

---

## 1. 핵심 원칙

| 원칙 | 구현 |
|------|------|
| **발행·소각 균형** | 모든 화폐 흐름을 `economy_flow_logs`에 기록 → 5분 단위 순유입 계산 → 발행률 자동 조절 |
| **차익거래 차단** | 모든 시장(Slot/주식/도박/채굴)에 **0.3% 거래세 + 5초 슬리피지 + 가격 band 5%** |
| **중앙은행 독립성** | `bankInterestRate`, `taxRate`, `forcedRegimeIndex` 는 **매 사이클 0.5% 점진 변경** (급격한 shock 회피) |
| **디플레이션/인플레이션 자동역전** | 자동 안정화 장치가 인위적 경기 부양/긴축을 강제 |
| **로깅 무손실** | 모든 money 변동은 (before, after, type, source) 4-tuple 필수 기록 |
| **GC 보호** | 메모리 캐시/타이머는 setInterval.unref()로 봇 종료 방해 금지 |

---

## 2. 통화 흐름 (Money Flow Pipeline)

```
┌─────────┐  채굴+수당   ┌──────────┐  거래세  ┌─────────┐
│  채굴/사업 │ ─────────→ │  유저 캐시│ ──────→ │   국고    │
└─────────┘             └──────────┘         │ taxTreasury│
                                          └─────────┘
   ▲                           │                  │
   │ 차감                       │ 무상증자/지원금   │ 환급
   │                           ▼                  ▼
┌─────────┐               ┌──────────┐         (사용자)
│  카지노   │  잭팟손실  ─→│   은행    │  대출  ───────┐
└─────────┘               │   예금    │                │
                          └──────────┘                ▼
                           (은행이 차감) ────────→ (국고 환급)
```

**소스(Source)**: 채굴 보상, 카지노 잭팟, 은행 이자, 주식 배당, 출석, 정부 보조금
**싱크(Sink)**: 거래세, 송금세, 자산세, 대출 상환, 카지노 하우스 수수료, 채굴 비용

---

## 3. 자동 균형 알고리즘 (AutoBalancer)

**주기**: 5분 (이전 10분)

**지표**:
- M2 통화량 (현금 + 예금, 주식 제외)
- 24h 순유입(`economy_flow_logs`)
- 지니계수 / 상위 1% 점유율
- 주식 평균 변동률

**결정 트리** (히스테리시스 3회 연속 감지):
```
M2 ↑ 20%+ for 3 cycles  →  인플레이션 모드
M2 ↓ 20%+ for 3 cycles  →  디플레이션 모드
지니 > 0.75 for 3 cycles →  불평등 모드
M2 stable + 지니 < 0.60  →  NORMAL
```

**모드별 자동조치** (모두 **±5% MAX** 강도):

| 모드 | 출석 | 노동 | 지원금 | 카지노 | 사업 | 자동채굴 | 부유세 | 금리 | 주식국면 |
|------|------|------|--------|--------|------|----------|--------|------|---------|
| INFLATION | ↓5% | ↓5% | ↓3% | ↓5% | ↓5% | ↓5% | +5% | ↑5% | 조정기 |
| DEFLATION | +5% | +5% | +5% | - | +5% | +5% | ↓5% | ↓5% | 부양기 |
| INEQUALITY | - | - | +5% | - | - | - | +5% | - | - |

---

## 4. 차익거래 차단 (Anti-Arbitrage)

### 4.1 주식 ↔ 다른 시장
- 매수/매도마다 **0.3% 슬리피지** (0~0.5% randomNoise)
- **틱 간격 3분** 으로 단타 차단
- 유저 매매 영향 ±0.3% MAX

### 4.2 카지노 ↔ 주식 ↔ 채굴
- 모든 시장 진입에 **0.05% 거래세**
- 잭팟 페이아웃은 즉시 국고로 재충전 (쿠르네티어 절 방지)
- 채굴의 AUTO_MINER_MAX_LEVEL = 50 (캡 초과 불가)

### 4.3 송금 ↔ P2P 대출 ↔ 은행
- 송금 1% 수수료 (세금왕 0.5%)
- P2P 담보 시 주식 또는 현금 **택 1** (이중지급 방지 - 이미 FIX 완료)
- 은행 대출이자 **0.15%/h** (예금 0.05%/h의 3배 → 스프레드 = 차익 이익 없음)

---

## 5. 자산세 (Wealth Tax) 정밀화

| 순자산 구간 | 세율 | 보호 |
|--------------|------|------|
| ~ 500만 | 0% | 빈곤층 면제 |
| 500만~1,000만 | 3% | |
| 1,000만~5,000만 | 6% | |
| 5,000만~2억 | 9% | |
| 2억~10억 | 12% | |
| 10억~50억 | 16% | |
| 50억+ | 20% | |

- 과세 대상: **현금+예금 + 주식 50%**
- 10분 주기, 연간 52,560회 분할
- **회당 유동자산의 0.20% cap** (한 번에 큰 금액 깎이는 것 방지)

---

## 6. 데이터베이스 통합 스키마

### 6.1 신규 테이블
```sql
economy_flow_logs (
  id BIGINT PK,
  ts DATETIME,
  category ENUM('MINT','SINK','TRANSFER','ASSET') INDEX,
  amount DECIMAL(65,0),
  source_user_id VARCHAR(32) NULL,
  sink_user_id VARCHAR(32) NULL,
  reason VARCHAR(64)
)
```

### 6.2 핵심 테이블
- `users`: cash/bank/clicker/auto_miner/level/streak
- `stocks`, `stock_history`, `stock_transactions`, `stock_limit_orders`
- `gambling_logs`: 모든 도박 거래 추적 (롤백 가능)
- `bank_loans`: 예금 담보 대출
- `p2p_loans`: P2P 대출 + 담보
- `user_businesses`: 사업 (12단계)
- `economy_health_log`: 자동조절 결정 이력
- `economy_settings`: 동적 배율 키-값 저장소

---

## 7. 캐시 무효화 정책

| 캐시 | TTL | 무효화 트리거 |
|------|-----|---------------|
| userSnapshot | 5초 | user:sync, 관리자 명령, 큰 변동 (10%+) |
| tax/loan view | 30초 | 만료시 |
| stock prices | 10초 | 새 틱 |

---

## 8. 안전 가드 (Safety Guards)

### 8.1 Rate Limit
- 클릭: 25ms/clk min + 200 clicks/request max
- 카지노 베팅: 쿨다운 1초
- 송금: 사용자별 1시간 1억 cap

### 8.2 누수 방지
- 타임아웃 5초
- try/catch 모든 async 경로
- balance_before/after 검증 (lostUpdates 추적)

### 8.3 동시성
- 모든 유저 자산 변경은 `withUserLock(userId)` 내에서 실행
- treasury는 `treasuryLock` Semaphore (단일)
- 분단위 cron 작업은 `multiProcessLock` 사용

---

## 9. 리스크 관리

### 9.1 채굴 자동 캡
```
AUTO_PER_LEVEL_PER_SEC: 3
AUTO_MINER_MAX_LEVEL: 50
→ 최대 150원/초 = 9,000원/분 = 540,000원/시간
→ 100만원 채굴에 2시간 (과거 13분 → 12배 느려짐)
```

### 9.2 차익거래 제거 검증 (메트릭)
- 카지노 환원율 ≤ 95% (5% 하우스)
- 주식 평균 거래 비용 ≥ 0.5%
- P2P 대출 양쪽 이자격차 ≥ 0.10%/h

---

## 10. 향후 계획 (Future)

1. **NFT/수집품 시장** - 주식 외 자산 다양화
2. **거버넌스 토큰** - 유저 투표로 정책 변경
3. **계절 이벤트** - 크리스마스, 벚꽃 등 시즌 한정 보너스
4. **AI 봇 트레이더** - 거시 균형 도모
5. **연동 차트 (TradingView)** - 외부 분석 도구

---

## 11. 운영 매뉴얼

### 11.1 부팅 시
```
1. ensureDatabaseExists() → DB 없으면 생성
2. ensureWideMoneyColumns() → DECIMAL(65) 검증
3. ensureRuntimeIndexes() → 색인 마이그레이션
4. startAutoBalancer() → 5분 후 첫 분석
5. startStockEngine(180000) → 3분 후 첫 틱
6. startBankEngine() → 60초 후 첫 이자
7. startAutoMiner() → 1초 후 첫 지불
8. startTotoEngine() → 5분 주기
```

### 11.2 비상 정지
- `taxRate=0` 설정 또는 `taxPolicyLocked=true`로 관리자 개입 가능
- `dynamicSettings.taxPolicyLocked = true` → 자동조절 skip

### 11.3 데이터 초기화
- `node scripts/reset_user_data.js` → 관리자 보존, 일반 유저 초기화

---

**© 2026 월덕 경제 연구소 — 모든 차익 거래 시도는 자동 차단됩니다.**
