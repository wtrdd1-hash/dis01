# easy-scraping.com 운영·테스트 관리자 QA 비교

- 점검일: 2026-08-21 KST
- 최종 재확인: 2026-08-21 17:53 KST
- 결론: **두 환경의 코드는 다르며, 테스트 이미지를 그대로 운영에 배포하면 안 된다.**

## 1. 환경 스냅샷

| 항목 | 운영 | 테스트 |
|---|---|---|
| 도메인 | `easy-scraping.com` | `test.easy-scraping.com` |
| 이미지 | `fe3ee4c369b3…` | `e865de020d70…` |
| 태그 | `prod-20260821151559` | `test-20260821173730` |
| 최종 외부 버전 라벨 | 2026.08.21 17:47 | 2026.08.21 17:45 |
| 상태 | healthy, restart 0 | healthy, restart 0 |
| 역할 | 웹+DB+Discord 봇 | 웹+DB, 봇 비필수 |
| 최종 QA | 조건부 FAIL | FAIL / 승격 금지 |

두 환경은 최종 외부 조회 5회에서 각각 위 버전으로 일관되게 분리됐다. 단, 17:45 KST 전후 전체 컨테이너 재기동 직후에는 두 도메인이 잠시 동일한 구버전 `00:21`과 `/shop` 404를 반환했다. 같은 시각 미니PC 직접 origin은 정상 응답했으며 17:51 KST 이후 외부 경로도 복구됐다. 이는 기능 코드와 별개의 Cloudflare Tunnel 전환·connector 관리 위험이다.

## 2. 관리자 기능 비교

| 기능 | 운영 | 테스트 |
|---|---:|---:|
| 일반 관리자 페이지 11개 | 200 | 200 |
| 공지 등록 폼 | 있음 | 있음 |
| 관리자 공지 목록 API | 200 | **404** |
| 관리자 공지 등록 API | 라우트·검증 정상 | **라우트 누락/403** |
| 공개 팝업 API | 200 | **404** |
| 홈 공지 팝업 | 표시 | **미표시** |
| 상점 공지 팝업 | 표시 | **스크립트 누락** |
| 소비 관리자 화면 | 404 | 200 |
| 소비 catalog/workshop/ledger | 404 | 200 |
| 비로그인 관리자 차단 | 403 | 403 |
| 잘못된 Origin 차단 | 403 | 403 |
| 관리자 정적 자산 | 3/3 정상 | 3/3 정상 |

## 3. 실제 배포 코드 차이

해시가 다른 핵심 파일:

| 파일 | 의미 |
|---|---|
| `src/web/server.js` | 테스트에서 공개 팝업 API가 유실됨 |
| `src/web/routes/adminRoutes.js` | 테스트에서 공지 CRUD가 유실되고 소비 관리자 API가 추가됨 |
| `src/web/adminPageRoutes.js` | 테스트에 `/admin/spending` 추가 |
| `src/web/views/admin/header.ejs` | 테스트 관리자 메뉴에 소비 기능 추가 |
| `src/web/views/admin/console.ejs` | 최신 테스트에서 변경됐지만 공지 백엔드는 없음 |
| `src/web/views/shop.ejs` | 운영 명품 상점과 테스트 소비 허브 UI가 다름 |

공통이거나 동일 계열인 파일에는 `adminManagementRoutes.js`, 관리자 footer, 공지 팝업 JavaScript가 있다. 팝업 JavaScript가 동일해도 테스트 서버의 공개 API가 404이므로 다이얼로그를 표시할 데이터가 없다.

### 운영에만 존재하는 라우트

- `GET /api/announcements/popup`
- `GET /api/admin/announcements`
- `POST /api/admin/announcements`
- `DELETE /api/admin/announcements/:id`
- `PATCH /api/admin/announcements/:id/toggle`

### 테스트에만 존재하는 라우트

- `/admin/spending`
- `/api/admin/spending/users/...`
- `/api/admin/spending/catalog`
- `/api/admin/spending/workshop`
- `/api/admin/spending/ledger`

올바른 승격 버전은 두 기능 집합을 모두 포함해야 한다.

## 4. 공통 결함

1. 비로그인 상점이 로그인 안내 없이 구매 버튼을 활성화한다.
2. 메인 활동 유저 수와 부자 순위 표시 필드가 잘못 매핑돼 있다.
3. `/admin/audit`가 특정 사용자 전용으로 하드코딩돼 있다.
4. 관리자 UI에는 CSRF 보호 API용 토큰 전송 구현이 없다.
5. Docker 이미지의 `npm test`가 테스트 0개로 성공 종료한다.
6. CSP가 `frame-ancestors`만 지정해 스크립트 실행 정책이 약하다.

## 5. 환경별 고유 위험

### 운영

- `/admin_give`가 실제 지급·감사 기록 후 Discord 응답 오류를 냈다.
- 관리자가 실패로 오인해 재시도하면 중복 지급 가능성이 있다.
- 국고 잔액이 음수로 표시된다.

### 테스트

- 공지 폼은 있지만 CRUD 라우트가 없다.
- Discord 공지를 만들 수 있어도 공개 API가 없어 웹에 표시되지 않는다.
- 상점에서 비로그인에게 관리자 관제 링크가 노출된다.
- QA 중 이미지가 반복 교체되어 검증 기준이 자주 변했다.

### 공통 인프라 전환 위험

- 전체 재기동 직후 두 도메인이 같은 구버전 origin으로 잠시 연결됐다.
- 최종 상태는 운영 `17:47`, 테스트 `17:45`로 복구됐지만 `/readyz`만 보면 이 오배선을 구분할 수 없다.
- Cloudflare Tunnel connector 목록·중복 실행 위치를 점검하고, 배포 게이트에 외부 `/api/version` 환경 일치 검사를 추가해야 한다.

## 6. 자동 테스트의 사각지대

- 로컬 워크스페이스: 29개 발견, 28 PASS, 1 SKIP(MySQL 동시성)
- 운영 이미지: 0개 실행, exit 0
- 테스트 이미지: 0개 실행, exit 0
- 로컬 테스트는 공지 서비스와 UI 문자열은 검사하지만 실제 `server.js`/`adminRoutes.js`에 라우트가 마운트됐는지 검사하지 않는다.

필수 추가 테스트:

1. 앱 부팅 후 route manifest 스냅샷
2. 관리자 세션 `GET /api/admin/announcements` 200
3. 테스트 DB에서 공지 생성 → 공개 팝업 200 → 홈 dialog → 삭제
4. `/admin/spending`과 catalog/workshop/ledger 200
5. 비로그인 구매 401와 UI 버튼 disabled 동시 검증
6. 실행 테스트 수가 기준 미만이면 CI 실패

## 7. 승격 조건

1. 운영 공지 CRUD와 공개 팝업 API를 테스트 코드에 복원한다.
2. 테스트 소비 관리자 기능을 유지한다.
3. `adminManagementRoutes`의 `/api/admin` 광역 중복 마운트를 제거한다.
4. 관리자 공통 `adminFetch`에 CSRF 토큰 전달을 구현한다.
5. `/admin_give`를 단일 응답·트랜잭션·idempotency 방식으로 수정한다.
6. 최신 테스트 이미지를 고정하고 통합 QA 8/8 PASS 후 최소 15분 안정성을 확인한다.
7. 테스트에서 검증한 동일 이미지 ID만 운영에 승격한다.

현재는 운영 이미지를 유지하고 테스트 이미지는 승격하지 않는 것이 최종 권고다.
