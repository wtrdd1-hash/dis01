# 관리자 경제 페이지 QA 보고서

- 대상: `https://test.easy-scraping.com/admin/economy`
- 환경: `ssh wtrdd-direct` / `wtrdd-test-app`
- 배포 릴리스: `test-20260822120603`
- 수행일: 2026-08-22 (KST)
- 배포본/로컬 주요 파일 SHA-256: 일치
- 결론: **조회와 빠른 자금 지급·회수는 정상이나, 경제 정책 직접 제어 기능은 현재 운영 신뢰 불가**

## 1. 요약

전용 자동화 52건을 실행해 37건 통과, 15건 실패를 확인했다. 15건의 실패는 중복 경계값을 포함하며, 원인 기준으로 정리하면 P1 6건, P2 5건, P3 1건이다.

정상 확인 항목:

- 비관리자 페이지/API 접근 403
- 악성 Origin 쓰기 요청 403
- 기본 페이지 및 모든 주요 컨트롤 렌더링 200
- 페이지당 50/100/200건, 서버 최소 10/최대 200 제한
- 검색 결과/검색 결과 없음 상태
- SQL injection 형태 검색 입력의 안전한 처리
- 검색어 HTML 이스케이프
- 유형 필터가 반환한 행의 타입 일치
- 자동/수동/일시중지 모드 전환
- 빠른 자금 지급/회수 및 로그 검색
- 잘못된 금액, 존재하지 않는 사용자, `confirm=true` 누락 차단
- 테스트 사용자와 테스트 로그 삭제, 원래 경제 설정 복원

핵심 실패:

- 세율, 부유세 배율, 예금금리, 지원금 배율, 자산세 기준 변경이 성공으로 표시되고 DB에도 저장되지만 실행 중 경제 엔진에는 적용되지 않음
- 주식 국면의 “자동” 선택이 `null`이 아니라 0번 번영기로 저장됨
- UI/주식 엔진에 없는 국면 9번을 API가 허용함
- 잘못된 설정값이 거부되면서도 HTTP 200을 반환함
- 존재하지 않는 페이지 번호를 마지막 페이지로 보정하지 않음

## 2. 결함 목록

### QA-ECO-001 — P1 — 직접 설정 5종이 실행 중 엔진에 적용되지 않음

재현:

1. `GET /admin/api/economy-controls/snapshot`으로 원래 값을 확인한다.
2. `POST /admin/api/economy-controls/bulk-update`로 값을 변경한다.
3. 응답의 `success=true`, `applied` 및 DB의 변경값을 확인한다.
4. 다시 snapshot을 조회한다.

실측:

| 설정 | 요청값 | API 직후 snapshot | DB 저장값 |
|---|---:|---:|---:|
| `taxRate` | 0.0137 | 0.1 | 0.0137 |
| `wealthTaxMultiplier` | 1.37 | 1 | 1.37 |
| `bankInterestRate` | 0.000000133 | 0.000000902777... | 0.000000133 |
| `subsidyMultiplier` | 1.37 | 1.24 | 1.37 |
| `wealthThresholdForTax` | 7,654,321 | 5,000,000 | 7,654,321 |

원인:

- `getDynamicSettings()`가 원본이 아니라 복사본을 반환한다.
- `bulkUpdate()`는 그 복사본의 속성만 수정하고 성공을 반환한다.
- 결과적으로 현재 프로세스는 이전 값을 계속 사용하고, DB 값은 다음 재시작 때 뒤늦게 로드될 수 있다.

영향:

- 관리자는 즉시 적용되었다고 오인한다.
- 재시작 전후 정책이 달라져 예측하기 어려운 세금·지원금·금리 상태가 된다.
- 현재 페이지의 핵심 목적 자체가 실패한다.

근거 코드:

- `src/utils/economyControls.js:175-190`
- `src/utils/economyBalancer.js:678-680`

권고:

- `economyBalancer`에 검증된 단일 setter를 만들고, 메모리 변경과 DB 저장을 한 트랜잭션성 흐름으로 처리한다.
- DB 저장 실패 시 메모리 값을 롤백하고 5xx를 반환한다.
- API 테스트에 “POST 후 snapshot과 실제 소비 모듈 값이 동일함”을 필수로 추가한다.

### QA-ECO-002 — P1 — 시장 국면 자동 복귀와 인덱스 검증 오류

재현 결과:

- `{ forcedRegimeIndex: null }` 요청 → 성공 응답의 적용값이 `0`
- `{ forcedRegimeIndex: 9 }` 요청 → HTTP 200, `success=true`
- UI와 `MARKET_REGIMES`는 0~8만 제공한다.

원인:

- `Number(null)`이 0으로 변환된 뒤 `n !== null` 검사를 수행한다.
- 서버 허용 범위가 0~9로 잘못 정의되어 있다.
- 페이지용 설정은 `stockEngine.setMarketRegime()`과 직접 연결되지 않고 별도 상태를 수정하려 한다.

영향:

- 관리자가 “자동”으로 돌려놓아도 0번 번영기 강제가 남는다.
- 9번을 저장한 뒤 재기동하거나 연동 코드를 수정하면 존재하지 않는 국면으로 인한 런타임 오류 가능성이 있다.
- QA 종료 후 복원된 현재 상태도 `autoMode=auto`, `forcedRegimeIndex=1`로 서로 의미가 충돌한다.

근거 코드:

- `src/utils/economyControls.js:145-151`
- `src/web/views/admin/economy.ejs:466-483`
- `src/utils/stockEngine.js:7-16`
- `src/utils/stockEngine.js:1362-1369`

권고:

- `v === null`을 숫자 변환 전에 분기한다.
- 허용 범위를 `0 <= index < MARKET_REGIMES.length`로 단일화한다.
- 수동 강제/자동 해제 API를 `stockEngine`의 실제 상태와 연결한다.

### QA-ECO-003 — P1 — 예금금리 슬라이더 값이 실제 이자 계산에서 항상 후순위

`bankEngine.getCurrentInterestRate()`는 `macroState.baseInterestRate > 0`이면 거시경제 금리를 즉시 반환한다. 거시경제 기준금리는 초기 3.5%이며 계산상 1~8.5% 범위로 유지되므로, 관리자 `bankInterestRate`는 정상 상태에서 사용되지 않는다.

영향:

- QA-ECO-001을 수정해도 예금금리 슬라이더는 실제 지급 이자에 영향을 주지 않는다.

근거 코드:

- `src/utils/bankEngine.js:30-45`
- `src/utils/macroEconomics.js:25-33`
- `src/utils/macroEconomics.js:68-72`

권고:

- 관리자 수동/잠금 모드에서는 관리자 금리를 우선하도록 우선순위를 명시한다.
- 자동 모드에서만 거시경제 금리를 사용한다.

### QA-ECO-004 — P1 — 지원금 배율이 실제 지원금 지급에 사용되지 않음

웹과 Discord 지원금 기능은 모두 고정 `SUBSIDY.AMOUNT`를 지급한다. `subsidyMultiplier`는 경제 조절 상태와 화면에 존재하지만 지급 계산에는 반영되지 않는다.

영향:

- 지원금 배율 슬라이더는 QA-ECO-001 수정 후에도 무효하다.

근거 코드:

- `src/web/routes/economyRoutes.js:357-364`
- `src/commands/economy/subsidy.js:55-79`

권고:

- 웹/Discord 경로가 같은 서비스 함수를 사용하도록 통합하고, 그 함수에서 동적 배율을 한 번만 적용한다.

### QA-ECO-005 — P1 — 자산세 UI 범위와 실제 계산 범위 불일치

확인 사항:

- UI/API는 자산세 기준을 10만~100억으로 허용한다.
- 실제 누진세 계산은 500만원 미만을 무조건 0으로 처리한다.
- 실제 징수 루프에도 500만원 하드코딩 조건이 남아 있다.
- UI/API는 부유세 배율 최대 5배를 허용하지만 실제 계산은 최대 3배로 제한한다.

영향:

- 10만~499만 원 기준과 3~5배 설정은 화면 표시와 실제 과세 결과가 다르다.

근거 코드:

- `src/web/views/admin/economy.ejs:192-196`
- `src/utils/economyControls.js:138-163`
- `src/utils/taxEngine.js:102-106`
- `src/utils/taxEngine.js:449-460`

권고:

- 정책 기준과 배율 상한을 단일 상수/스키마에서 공유한다.
- `computeProgressiveWealthTax`에 정책 기준을 전달해 하드코딩 500만원을 제거한다.

### QA-ECO-006 — P2 — 거부된 설정 요청이 HTTP 200을 반환함

세율 하한/상한, 금리 상한, 부유세 배율 하한, 자산세 기준 하한, 지원금 배율 상한, 알 수 없는 키 모두 `success=false`와 `skipped`를 반환했지만 HTTP 상태는 200이었다.

영향:

- 모니터링과 자동화가 실패를 성공으로 집계한다.
- 프런트 외 클라이언트가 본문을 확인하지 않으면 오류를 놓친다.

근거 코드:

- `src/web/routes/adminRoutes.js:1991-2001`

권고:

- `applied.length === 0`이면 400 또는 422를 반환한다.
- 일부 성공/일부 거부는 200과 명확한 부분 성공 상태를 사용한다.

### QA-ECO-007 — P2 — “수동(잠금)” 표시와 실제 잠금 상태 불일치

자동모드를 `manual`로 바꾸면 페이지는 “수동 (잠금)”으로 표시하지만 snapshot의 `taxPolicyLocked`는 false였다. `setAutoMode()`가 모드만 바꾸고 잠금 필드는 바꾸지 않는다.

영향:

- 운영자가 정책 잠금 여부를 오판할 수 있다.
- 다른 화면/API는 동적 설정의 잠금 상태를 보고 상반된 상태를 표시할 수 있다.

근거 코드:

- `src/utils/economyControls.js:82-91`
- `src/web/views/admin/economy.ejs:388-407`

### QA-ECO-008 — P2 — 범위를 넘는 페이지 번호를 보정하지 않음

`/admin/economy?page=999999&lines=50` 요청 결과:

- 표시: `999999 / 241 페이지`
- 데이터: 빈 결과
- HTTP: 200

원인:

- page는 최소 1만 적용하고, totalPages 계산 후 상한을 적용하지 않는다.

근거 코드:

- `src/web/adminPageRoutes.js:175-202`

권고:

- count 계산 후 `page = Math.min(page, totalPages)`로 보정하고 offset을 다시 계산한다.

### QA-ECO-009 — P2 — 제어 변경 이력이 메모리에만 있고 DB 오류를 숨김

확인 사항:

- 컨테이너 재시작 직후 history는 0건이었다.
- history는 최근 20건 메모리 배열뿐이며 재시작 시 사라진다.
- 설정 저장 및 수동 상태 저장의 DB 오류를 빈 `catch`로 무시한다.
- 그 상태에서도 성공 응답이 가능하다.

영향:

- 누가 언제 어떤 경제 정책을 바꿨는지 장기 감사가 불가능하다.
- DB 장애 때 화면이 성공으로 표시될 수 있다.

근거 코드:

- `src/utils/economyControls.js:16-27`
- `src/utils/economyControls.js:56-76`
- `src/utils/economyControls.js:179-190`

권고:

- `economy_control_audit` 또는 기존 `admin_action_logs`에 전/후 값을 영구 기록한다.
- 저장 실패를 숨기지 말고 실패 응답과 서버 오류 로그를 남긴다.

### QA-ECO-010 — P2 — 빠른 자금 작업이 UI에서 사실상 1클릭 확정

서버는 `confirm=true` 누락을 정상 차단했다. 그러나 모달의 “돈 지급/돈 회수” 버튼이 추가 확인 대화상자 없이 바로 `confirm:true`를 전송한다.

추가 위험:

- 회수 API는 `allowNegative`를 보내지 않으면 기본 true여서 잔액보다 큰 금액을 회수해 음수 현금을 만들 수 있다.
- 이 동작이 의도된 채무 기능이라면 모달에 명시적인 경고와 2단계 확인이 필요하다.

근거 코드:

- `src/web/views/admin/footer.ejs:52-76`
- `src/web/views/admin/footer.ejs:182-196`
- `src/web/routes/adminRoutes.js:244-250`
- `src/web/routes/adminRoutes.js:941-967`

### QA-ECO-011 — P3 — API 연환산 금리가 60배 크게 표시됨

현재 snapshot:

- 분당 금리: `9.027777777777778e-7`
- API `bankInterestRateAnnualPercent`: `2847.00%`
- 페이지 자체 환산식 기준: 약 `47.45%/년`

원인:

- API 요약식에 `60 * 60 * 24 * 365`가 사용되어 분당 값을 연환산할 때 60이 한 번 더 곱해진다.

근거 코드:

- `src/utils/economyControls.js:249-258`
- `src/web/views/admin/economy.ejs:510-516`

### QA-ECO-012 — P1 — 배포 컨테이너의 `npm test`가 테스트 0건으로 성공함

실행 결과:

```text
tests 0
pass 0
fail 0
duration_ms 29.237813
exit code 0
```

원인:

- Dockerfile은 `src`와 `scripts`만 복사하고 `test`를 복사하지 않는다.
- `package.json`의 `npm test`는 파일 미존재를 실패로 보지 않는다.

영향:

- 배포 검증에서 회귀 테스트가 전혀 실행되지 않아도 성공으로 보인다.
- 이번 경제 제어 결함을 자동 배포가 잡지 못한다.

근거 코드:

- `Dockerfile:11-12`
- `package.json`의 `scripts.test`

권고:

- 테스트 전용 빌드 단계 또는 CI에서 소스 체크아웃 기준으로 테스트한다.
- 최소 테스트 수가 1 이상인지 별도 검사하고, 0건이면 실패 처리한다.
- 경제 관리자 페이지 전용 테스트를 CI에 추가한다.

## 3. 기능별 결과

| 영역 | 결과 | 비고 |
|---|---|---|
| 관리자 권한 | PASS | 페이지/API 비관리자 403, 악성 Origin 403 |
| 기본 렌더링 | PASS | 주요 폼, 테이블, 6개 제어군, 빠른 자금 모달 존재 |
| 목록/검색 | PASS | 50/100/200, no-result, 검색 이스케이프 |
| 페이지 범위 | FAIL | 최대 페이지 초과 입력 미보정 |
| 유형 필터 | PASS/제한 | 현재 존재하는 유형은 정상; GAMBLE/LOAN/TRANSFER는 테스트 데이터 0건 |
| 자동모드 | PASS/주의 | auto/manual/paused 전환 성공, 잠금 표시는 불일치 |
| 직접 경제 설정 | FAIL | API/DB 성공과 런타임 상태 불일치 |
| 시장 국면 | FAIL | null→0, 9 허용, 실제 주식 엔진 연결 불명확 |
| 빠른 지급/회수 | PASS/주의 | 임시 사용자로 잔액·로그 검증, UI 추가 확인 없음 |
| 입력 검증 | PARTIAL | 본문은 거부하나 설정 API HTTP 상태가 200 |
| 보안 기본기 | PASS | 권한, Origin, 파라미터 바인딩, HTML 이스케이프 |
| 회귀 테스트 | FAIL | 배포 이미지에서 0건 실행 후 성공 종료 |

## 4. 테스트 데이터와 복원 확인

- 생성한 `qa_economy_*` 사용자: 0건 잔존
- 테스트 사용자의 `economy_logs`, `admin_action_logs`, `transaction_logs`: 삭제
- 변경한 `economy_settings` 키: 원래 DB 값으로 복원
- 최종 snapshot:
  - `autoMode=auto`
  - `taxPolicyLocked=false`
  - `taxRate=0.1`
  - `wealthTaxMultiplier=1`
  - `bankInterestRate=9.027777777777778e-7`
  - `wealthThresholdForTax=5000000`
  - `forcedRegimeIndex=1`
  - `subsidyMultiplier=1.24`
- 컨테이너: healthy

## 5. 제한 및 추가 확인 필요

- 인앱 브라우저 세션에는 관리자 로그인이 없어 실제 URL은 403 화면까지 확인했다. 인증된 관리자 동작은 컨테이너 내부에서 동일한 정식 서명 세션을 사용해 HTTP/HTML/API로 검증했다.
- 따라서 실제 브라우저에서의 드래그, 모바일 반응형, 포커스 이동, 키보드 접근성, 토스트 시각 품질은 이번 실행에서 완전 검증하지 못했다.
- GAMBLE/LOAN/TRANSFER 필터는 현재 해당 ledger 데이터가 0건이므로 실제 데이터 포함 상태의 의미적 커버리지는 별도 시드 후 확인해야 한다.

## 6. 수정 우선순위

1. QA-ECO-001과 QA-ECO-002를 먼저 수정해 메모리/DB/실제 소비 엔진을 원자적으로 일치시킨다.
2. 금리·지원금·자산세의 실제 소비 경로를 관리자 설정과 연결하고 범위를 단일화한다.
3. 실패 HTTP 상태, 페이지 상한, 수동 잠금 상태를 정리한다.
4. 제어 이력을 영구 감사 로그로 전환하고 DB 오류를 노출한다.
5. 배포 CI에 본 보고서의 52건 자동화와 “테스트 0건 실패” 가드를 포함한다.

## 7. 재실행

전용 실행기: `scripts/qa_economy_page.js`

이 실행기는 관리자 ID, 쿠키 비밀, 서명 쿠키를 출력하지 않는다. 테스트 사용자와 설정값을 `finally`에서 복원하도록 구성되어 있다.
