# test.easy-scraping.com 테스트 서버 관리자 QA 리포트

- 점검일: 2026-08-21 KST
- 대상: `https://test.easy-scraping.com/`, 테스트 Docker 컨테이너, 관리자 페이지와 소비·공지 API
- 최종 확인 이미지: `e865de020d70…`, `test-20260821173730`
- 방식: 실제 브라우저, 외부 HTTPS, 격리 통합 QA, 서버 내부 서명 관리자 세션, 배포 코드·로그 점검
- 데이터 변경: QA 임시 계정·구매·로또만 생성했고 종료 트랩으로 정리. 운영 데이터 변경 없음
- 최종 재확인: 2026-08-21 17:53 KST
- 최종 판정: **FAIL — 운영 승격 금지**

## 1. 서버 상태

| 항목 | 결과 |
|---|---|
| 컨테이너 | `wtrdd-test-app` |
| 상태 | running, healthy, restart 0, OOM false; 17:45 KST 재생성 |
| 실행 보안 | 사용자 `1000:1000`, read-only root filesystem |
| 관측 자원 | CPU 0.19%, 206.8 MiB / 768 MiB, PID 12 |
| 최종 외부 버전 | `2026.08.21 17:45` |
| `/healthz` | 200, web/db true, bot false |
| `/readyz` | 200, web/db true, botRequired false |

웹 전용 테스트 환경으로서 bot false는 정상 설계다. 최근 컨테이너 로그에 런타임 예외나 DB 오류는 없었다.

점검 중 테스트 이미지가 여러 번 자동 교체됐다. 이 문서의 최종 결과는 마지막 확인 이미지 `e865de020d70…` 기준이며 동일 이미지에서 통합 QA를 다시 실행했다.

17:45 KST 전후 전체 인프라 재기동 직후 테스트와 운영 공개 도메인이 잠시 같은 구버전 `00:21`을 반환했다. 미니PC 직접 origin은 정상이어서 Cloudflare Tunnel 전환 구간 문제로 판단한다. 17:51~17:53 KST 고유 쿼리 5회 재검증에서는 테스트 도메인이 모두 `17:45`를 반환했고 `/shop` 200, `/readyz` 200으로 복구됐다. 공개 팝업 API 404는 라우팅 장애가 아니라 아래에 기술한 테스트 이미지의 실제 라우트 누락이다.

## 2. 최신 이미지 통합 QA

| 단계 | 결과 |
|---|---|
| 컨테이너·헬스·migration 009 | PASS |
| 테스트 계정 가입·보안 쿠키·로그인 감지 | PASS |
| 잘못된 인증·Origin/CSRF 방어 | PASS |
| 상점 구매·잔액·인벤토리·소각 원장 | PASS |
| 로또 구매·트랜잭션·원장 | PASS |
| 관리자 공지 생성·팝업·삭제 | **FAIL** |
| Discord `/admin_notice` | 별도 실행 PASS |
| 외부 홈·상점 공지 스크립트 | 홈 스크립트 존재, 상점 스크립트 누락 |

통합 스크립트는 6/8에서 다음 오류로 중단됐다.

```text
관리자 공지 HTTP 403: {"success":false,"error":"CSRF 토큰 검증 실패"}
```

추적 결과 단순 CSRF 헤더 누락이 아니라 공지 API 라우트 자체가 최신 테스트 이미지에서 빠졌다. 미등록 POST가 후순위 `adminManagementRoutes`의 CSRF 미들웨어에 걸려 403으로 보이는 것이다.

## 3. 실제 브라우저·공개 화면 QA

| 항목 | 결과 |
|---|---|
| 홈 `/` | 200 |
| 상점 `/shop` | 200 |
| 비로그인 `/admin/users` | 403 |
| 비로그인 `/admin/console` | 403 |
| Discord OAuth | 302, 테스트 callback URL 정상 |
| 비로그인 구매 API | 401 |
| 공개 팝업 API | **404** |
| 기본 홈 팝업 | **표시 실패** |
| 상점 팝업/Socket.IO 스크립트 | **누락** |

상점은 비로그인 상태인데도 다음을 표시한다.

- 잔액 0원
- 황금 깃털 0개
- 활성 구매 버튼 최소 9개
- 활성 확성기 송출 버튼
- 공개 내비게이션에 `관리자 관제` 링크

구매 API와 관리자 페이지는 각각 401/403으로 차단되므로 인증 우회는 확인되지 않았다. 다만 로그인 안내가 없고 버튼이 활성 상태라 사용자 경험이 잘못됐으며 관리자 경로가 불필요하게 노출된다.

홈 통계도 정확하지 않다.

- 실제 통계는 상장 종목 10개인데 문구는 18개로 고정돼 있다.
- 활동 유저가 약 999억으로 표시되며 실제 사용자 수가 아니다.
- 이 값은 리더보드 최대 자산값을 사용자 수로 사용한 결과다.

## 4. 인증 관리자 페이지 QA

최신 이미지에서 다시 확인한 결과다.

| 관리자 경로 | 결과 |
|---|---:|
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
| `/admin/spending` | 200 |

관리자 콘솔 로컬 CSS/JavaScript 자산 3개는 모두 200이었다. 관리자 페이지 렌더링과 신규 소비 관리 화면 자체는 정상이다.

### 공지 기능

| 항목 | 결과 |
|---|---|
| 콘솔 공지 등록 폼 | 존재 |
| `GET /api/admin/announcements` | **404** |
| 공지 POST | **403**, 후순위 CSRF 라우터가 가로챔 |
| `GET /api/announcements/popup` | **404** |
| Discord 명령으로 DB 공지 생성 | PASS |
| Discord 공지를 홈 팝업으로 표시 | **FAIL** |

화면에는 등록 폼이 있지만 백엔드가 없어 목록 로드, 등록, 삭제, 토글이 모두 불가능하다. Discord 명령은 공지를 DB에 만들 수 있지만 웹 공개 API가 없어 사용자가 볼 수 없다.

### 신규 소비 관리자 기능

| 항목 | 결과 |
|---|---|
| `/admin/spending` | 200 |
| `/api/admin/spending/catalog` | 200 |
| `/api/admin/spending/workshop` | 200 |
| `/api/admin/spending/ledger` | 200 |

신규 소비·외형·제작·덕하우스 관리자 읽기 경로는 정상이다. 실제 저장·수정·삭제는 데이터 변경을 피하기 위해 수행하지 않았다.

### 관리자 쓰기 방어

| 검사 | 결과 |
|---|---|
| 빈 자금 지급 요청 | 400, 확인 검증 |
| 잘못된 Origin | 403 |
| admin-management 빈 삭제, CSRF 없음 | 403 |
| 비로그인 관리자 | 403 |

권한과 Origin 방어는 정상이다. 다만 관리자 UI에는 CSRF 토큰 전송 코드가 없으므로 CSRF가 필수인 `admin-mgmt` 쓰기 UI는 정상 호출이 어려울 수 있다.

## 5. 배포 코드 회귀

운영과 다른 주요 배포 파일:

- `src/web/server.js`
- `src/web/adminPageRoutes.js`
- `src/web/routes/adminRoutes.js`
- `src/web/views/admin/header.ejs`
- `src/web/views/admin/console.ejs`
- `src/web/views/shop.ejs`

테스트에만 추가된 기능:

- `spendingRoutes.js`
- `/admin/spending`
- spending catalog/workshop/ledger 관리자 API

테스트에서 사라진 운영 기능:

- `GET/POST/DELETE/PATCH /api/admin/announcements...`
- `GET /api/announcements/popup`

즉 신규 소비 기능을 추가하는 과정에서 기존 공지 라우트 블록과 공개 팝업 라우트가 유실됐다.

## 6. 결함 목록

### TEST-P0-001 — 관리자 공지 CRUD와 공개 팝업 API 누락

- 관리자 폼은 보이지만 API가 404다.
- POST는 잘못 마운트된 후순위 CSRF 라우터 때문에 403으로 위장된다.
- Discord 명령으로 공지를 만들어도 홈·상점에 표시되지 않는다.
- 운영 승격 시 현재 운영에서 정상인 공지 기능이 사라진다.

권고:

1. 운영 `adminRoutes.js`의 공지 CRUD를 테스트 브랜치에 복원한다.
2. 운영 `server.js`의 공개 팝업 조회 라우트를 복원한다.
3. `/api/admin`에 `adminManagementRoutes`를 광역 중복 마운트한 부분을 제거한다.
4. 생성 → 관리자 목록 → 공개 API → 홈 다이얼로그 → 삭제 E2E를 배포 필수 게이트로 추가한다.

### TEST-P1-002 — 비로그인 상점 로그인 상태 UI 누락

- 로그인 안내 없이 구매·확성기 버튼이 활성화된다.
- 관리자 관제 링크도 비로그인에게 노출된다.
- 백엔드 인증 차단은 정상이다.

### TEST-P1-003 — 관리자 UI와 CSRF 보호 API 불일치

- 관리자 템플릿에는 CSRF 토큰 전송 구현이 없다.
- CSRF 필수 admin-management 쓰기 API는 빈 요청에서 403을 반환한다.
- 토큰 발급·헤더 전송을 공통 `adminFetch`에 연결해야 한다.

### TEST-P1-004 — 배포 이미지 자동 테스트 0건

- 이미지 내부 `npm test`는 exit 0이지만 `tests 0`이다.
- 로컬 테스트 29개 중 28개가 통과해도 실제 라우트 조립을 검증하지 않아 이번 회귀를 잡지 못했다.
- 최소 테스트 수, 애플리케이션 부팅, 실제 route smoke를 CI 게이트로 추가해야 한다.

### TEST-P2-005 — 메인 통계 문구·활동 유저 계산 오류

- 상장 종목 문구와 실제 개수가 다르다.
- 활동 유저 대신 최대 자산값을 표시한다.

### TEST-P1-006 — 특정 사용자 전용 감사 화면 하드코딩

- 운영과 동일하게 `/admin/audit`가 특정 사용자 식별자에 고정돼 있다.
- 검색형 감사와 조회 사유·감사 로그 방식으로 변경해야 한다.

### TEST-P2-007 — 재기동 직후 외부 도메인이 잠시 구버전 origin을 반환

- 최종 상태는 정상 분리됐지만 readiness 200만으로 잘못된 환경 연결을 탐지할 수 없다.
- 도메인별 기대 `/api/version`과 핵심 경로를 확인하는 배포 후 외부 smoke test가 필요하다.

## 7. 보안 헤더

홈과 관리자 403 응답에 HSTS, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, COOP, Referrer-Policy, Permissions-Policy, `Cache-Control: no-store`가 적용된다.

CSP는 `script-src` 등이 없는 최소 정책이므로 향후 nonce 기반으로 강화할 필요가 있다.

## 8. 테스트 판정

- 가용성: **PASS**
- 로그인·구매·로또·원장: **PASS**
- 관리자 읽기 화면: **PASS**
- 신규 소비 관리자 읽기 기능: **PASS**
- 관리자 공지 등록: **FAIL**
- 기본 홈·상점 공지 팝업: **FAIL**
- 운영 승격: **금지**

공지 라우트를 복구하고 통합 QA 8단계를 전부 통과하기 전에는 본서버에 배포하면 안 된다.
