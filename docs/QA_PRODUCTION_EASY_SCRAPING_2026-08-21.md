# easy-scraping.com 운영 서버 관리자 QA 리포트

- 점검일: 2026-08-21 KST
- 대상: `https://easy-scraping.com/`, 운영 Docker 컨테이너, 관리자 페이지와 읽기 API
- 방식: 실제 브라우저, 외부 HTTPS, 서버 내부 서명 관리자 세션, 컨테이너 상태·로그, 배포 이미지 코드 점검
- 데이터 변경: 없음. 쓰기 API는 빈 입력 또는 잘못된 Origin만 사용해 상태 변경 전에 차단되도록 점검
- 최종 재확인: 2026-08-21 17:53 KST
- 최종 판정: **조건부 FAIL — 서비스는 복구·가동 중이나 P1 결함 수정 전 테스트 이미지 승격 금지**

## 1. 운영 상태

| 항목 | 결과 |
|---|---|
| 컨테이너 | `wtrdd-discord-app` |
| 이미지 | `fe3ee4c369b3…`, `prod-20260821151559` |
| 상태 | running, healthy, restart 0, OOM false; 17:47 KST 재생성 |
| 실행 보안 | 사용자 `1001:1001`, read-only root filesystem |
| 자원 관측 | CPU 0.69%, 232.4 MiB / 1 GiB, PID 12 |
| 최종 외부 버전 | `2026.08.21 17:47` |
| `/healthz` | 200, web/db/bot 모두 true |
| `/readyz` | 200, web/db/bot 모두 true |

서비스 가용성과 DB·Discord 봇 readiness는 정상이다. 최근 60분 컨테이너 로그에서 웹 5xx나 DB 예외는 발견되지 않았으나 Discord 관리자 명령 오류 1건이 확인됐다.

### 재기동 직후 외부 라우팅 전환 관측

- 17:45 KST 전후 미니PC의 프록시·Cloudflare Tunnel·운영·테스트 컨테이너가 함께 재기동됐다.
- 재기동 직후 두 공개 도메인이 잠시 동일한 구버전 `2026.08.21 00:21`을 반환했고 `/shop`·팝업 API도 404였다. 당시 미니PC의 직접 origin은 최신 버전과 `/shop` 200을 정상 반환해 외부 Tunnel 전환 구간 문제로 판단된다.
- 17:51~17:53 KST에 캐시 무효화 고유 쿼리로 5회 연속 재검증한 결과 운영 도메인은 모두 `17:47`, `/shop` 200, 팝업 API 200으로 복구됐다.
- 재발 감지를 위해 도메인별 기대 버전과 origin 버전을 함께 비교하는 배포 후 모니터를 권고한다.

## 2. 실제 브라우저·공개 화면 QA

| 항목 | 결과 |
|---|---|
| 홈 `/` | 200, 정상 렌더링 |
| 상점 `/shop` | 200, 정상 렌더링 |
| 비로그인 `/admin/users` | 403, 접근 차단 정상 |
| 비로그인 `/admin/console` | 403, 접근 차단 정상 |
| Discord OAuth | 302, 운영 callback URL 정상 |
| 공지 팝업 | 홈·상점에서 실제 다이얼로그 표시 |
| 비로그인 구매 API | 401 `로그인이 필요합니다.` |

브라우저에서 상점은 비로그인인데도 `10,000원` 잔액과 활성 구매 버튼 4개를 표시한다. 구매 API는 401로 차단하므로 인증 우회는 아니지만 로그인 상태 UI가 잘못됐다.

홈에는 다음 데이터 이상이 보인다.

- 안내 문구는 18개 상장 종목이라고 하지만 실제 통계는 46개다.
- 활동 유저가 10,000으로 표시되며 실제 인원 집계가 아니다.
- 부자 순위는 순자산 정렬값과 화면 표시값이 달라 1위 2원, 2·3위 10,000원처럼 보인다.
- 국고 잔액이 `-4,244`로 노출된다.

## 3. 인증 관리자 페이지 QA

서버 내부에서 비밀값을 출력하지 않는 서명 관리자 세션으로 읽기 점검했다.

| 관리자 경로 | 결과 |
|---|---:|
| `/admin` | 302 → `/admin/users` |
| `/admin/users` | 200 |
| `/admin/economy` | 200 |
| `/admin/audit` | 200 |
| `/admin/stocks` | 200 |
| `/admin/tax` | 200 |
| `/admin/loans` | 200 |
| `/admin/console` | 200 |
| `/admin/announcements` | 302 → `/admin/console#announcement-manager` |
| `/admin/security` | 200 |
| `/admin/inquiries` | 200 |
| `/admin/logs` | 200 |
| `/admin/spending` | 404 — 신규 소비 관리자 기능 미배포 |

관리자 콘솔이 참조하는 로컬 CSS/JavaScript 자산은 3개 모두 200이었다. EJS 렌더 오류나 관리자 페이지 5xx는 없었다.

### 공지 관리

| 항목 | 결과 |
|---|---|
| 공지 등록 폼 | 존재 |
| `GET /api/admin/announcements` | 200 |
| 빈 공지 POST | 400 `공지 제목을 입력해주세요.` — 라우트·검증 정상 |
| `GET /api/announcements/popup` | 200 |
| 실제 홈 팝업 | 표시 정상 |

운영의 기존 공지 CRUD와 공개 팝업 경로는 정상이다. 실제 공지를 새로 등록하거나 삭제하지는 않았다.

### 관리자 쓰기 방어

| 검사 | 결과 |
|---|---|
| 빈 자금 지급 요청 | 400, 확인·입력 검증 |
| 잘못된 Origin의 자금 지급 요청 | 403 `허용되지 않은 요청 출처` |
| admin-management 빈 삭제 요청, CSRF 없음 | 403 |
| 비로그인 관리자 접근 | 403 |

Origin 방어와 권한 검사는 정상이다. 다만 CSRF 보호된 `admin-mgmt` API를 호출하는 관리자 템플릿에는 CSRF 토큰 전송 코드가 없어, 해당 UI가 실제로 연결되면 정상 요청도 403이 될 수 있다.

## 4. 보안 헤더

홈과 관리자 403 응답 모두 다음 헤더를 제공한다.

- `Cache-Control: no-store`
- `Strict-Transport-Security: max-age=15552000; includeSubDomains`
- `Content-Security-Policy: frame-ancestors 'none'`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Cross-Origin-Opener-Policy: same-origin`
- `Referrer-Policy: strict-origin-when-cross-origin`
- 위치·마이크·카메라를 차단하는 `Permissions-Policy`

CSP는 클릭재킹 방어만 포함하고 `default-src`/`script-src`가 없어 XSS 피해 제한 정책으로는 불완전하다. 기능 수정 후 nonce 기반 CSP 강화를 권고한다.

## 5. 결함 목록

### PROD-P1-001 — `/admin_give`가 지급 성공 후 실패로 응답

- 운영 로그 시각: 2026-08-21 17:20 KST
- 로그 순서: `DISCORD_GIVE_MONEY` 감사 기록 성공 → `Interaction has already been acknowledged` → 오류 응답 전송도 실패
- 영향: 자금은 이미 지급됐는데 명령은 ERROR로 보인다. 관리자가 재시도하면 중복 지급될 수 있다.
- 추가 위험: `adminGive.js`는 유저 현금 변경, 국고 차감, 경제 로그를 하나의 트랜잭션으로 묶지 않는다. 국고 차감 또는 로그가 실패하면 부분 성공이 남을 수 있다.
- 권고: 명령 시작 시 한 번만 `deferReply`, 완료 시 `editReply`를 사용하고, 지급·국고·원장을 한 DB 트랜잭션과 idempotency key로 처리한다.

### PROD-P1-002 — 비로그인 상점 로그인 상태 오표시

- 잔액 10,000원과 구매 버튼이 활성화되지만 로그인 안내가 없다.
- 서버 구매 API는 401로 안전하게 차단한다.
- 권고: 비로그인 시 잔액 대신 `로그인 필요`, 모든 구매·확성기 버튼 비활성화, Discord 로그인 CTA를 표시한다.

### PROD-P1-003 — 메인 통계·순위·국고 데이터 신뢰성 문제

- 활동 유저 수 대신 최대 자산값을 사용한다.
- DB는 `net`으로 정렬하지만 화면은 `net_worth` 또는 현금을 표시한다.
- 국고가 음수다.
- 권고: 실제 사용자 수 쿼리, 순자산 필드명 통일, 국고 원장 대사와 음수 정책 확정이 필요하다.

### PROD-P1-004 — 특정 사용자 전용 감사 페이지 하드코딩

- `/admin/audit`가 특정 사용자 식별자를 소스에 고정하고 자동 조회한다.
- 권고: 검색형 감사 도구로 변경하고 조회 사유·감사 로그·보존 정책을 적용한다.

### PROD-P2-005 — 관리자 계정 관리 UI와 CSRF 계층 불일치

- `admins.ejs`는 `admin-mgmt` 쓰기 API를 호출하지만 CSRF 토큰을 전송하지 않는다.
- `/admin/admins`는 해당 템플릿 대신 `/admin/users#admin-users`로 리다이렉트되어 현재 기능 연결도 불명확하다.
- 권고: 사용하지 않는 템플릿을 제거하거나 CSRF 토큰 발급·전송을 포함해 정식 연결한다.

### PROD-P1-006 — 배포 이미지 자동 테스트가 0건 실행

- `docker run --rm --network none ... npm test`는 exit 0이지만 `tests 0`이다.
- 로컬 워크스페이스는 29개를 발견하지만 배포 이미지에는 실제 테스트 파일이 포함되지 않거나 테스트 탐색이 실패한다.
- 권고: 이미지 빌드 전에 CI에서 테스트를 실행하고, 실행 테스트 수가 최소 기준보다 작으면 실패시키는 게이트가 필요하다.

### PROD-P2-007 — 전체 재기동 직후 Cloudflare 경로가 잠시 구버전 origin을 반환

- 운영·테스트 두 도메인이 같은 구버전을 반환하는 전환 구간이 관측됐다.
- 최종 재검증에서는 정상 복구됐지만, readiness 200만으로는 잘못된 origin 연결을 탐지할 수 없다.
- 권고: Cloudflare Tunnel connector 중복 여부를 점검하고, 배포 후 `/api/version`의 환경별 기대값과 핵심 경로(`/shop`, 공지 API)를 외부에서 검증한다.

## 6. 운영 판정

- 가용성: **PASS**
- 공개 공지·팝업: **PASS**
- 관리자 읽기 화면: **PASS**
- 관리자 자금 명령: **FAIL / P1**
- 로그인 상태 UX·통계: **FAIL / P1**
- 신규 소비 관리자 기능: 미배포
- 테스트 이미지 승격: **금지**

현재 운영 이미지는 그대로 유지하는 편이 안전하다. 특히 테스트 이미지에는 운영에서 정상인 공지 라우트가 빠져 있으므로 동일 이미지 승격을 승인할 수 없다.
