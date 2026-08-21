# test.easy-scraping.com 전체 QA·보안 리포트

- 점검일: 2026-08-21 KST
- 최종 기능 점검 이미지: `sha256:1705e22d54ed…` (`discord-bot-app:test-latest`)
- 외부 버전: `2026.08.21 18:23`
- 대상: `https://test.easy-scraping.com/`, 관리자 페이지/API, 미니PC Docker·네트워크·DB·SSH
- 방식: 실제 브라우저, 외부 HTTPS/TCP, 서명 관리자 세션, 임시 계정 통합 QA, 배포 이미지 코드·로그·자동 테스트 점검
- 데이터 처리: 임시 계정·구매·로또·Discord 공지는 테스트 뒤 정리. 관리자 공지 API가 실패해 웹 공지는 생성되지 않음
- 최종 판정: **FAIL — 공지 회귀와 DB 외부 노출 해결 전 운영 승격 금지**

## 1. 요약

| 영역 | 판정 | 핵심 결과 |
|---|---:|---|
| 서비스 가용성 | PASS | `/healthz`, `/readyz`, `/shop` 200 |
| 로그인·쿠키 | PASS | 가입·재로그인·로그인 감지, Secure/HttpOnly/SameSite 쿠키 정상 |
| 상점·로또·원장 | PASS | 구매·잔액·인벤토리·소각 원장·로또 트랜잭션 정상 |
| 관리자 읽기 화면 | PASS | 주요 화면 12개 200, 리다이렉트 2개 정상 |
| 소비 관리자 API | PASS(읽기) | catalog/workshop/ledger 200 |
| 관리자 공지 등록 | **FAIL** | 목록 404, 등록 403, CRUD 라우트 누락 |
| 홈·상점 팝업 | **FAIL** | 공개 API 404, 홈 dialog 없음, 상점 스크립트 누락 |
| 인증·권한 경계 | PASS | 비로그인 관리자 403, 올바른 Origin 비로그인 구매 401 |
| 웹 보안 기본기 | PASS/보완 | TLS·HSTS·권한·경로 방어 정상, CSP는 약함 |
| 호스트 네트워크 | **FAIL** | MariaDB 3306이 인터넷에서 직접 연결 가능 |
| 배포 자동 테스트 | **FAIL** | 최신 이미지에서 테스트 0개로 성공 종료 |

## 2. 최신 서버 스냅샷

| 항목 | 결과 |
|---|---|
| 컨테이너 | `wtrdd-test-app` |
| 이미지 | `1705e22d54ed…` |
| 시작 시각 | 2026-08-21 18:23:09 KST |
| 상태 | running, healthy, restart 0, OOM false |
| 실행 사용자 | `1000:1000` |
| 파일시스템 | read-only root filesystem |
| 권한 | privileged false, Linux capabilities `ALL` drop, no-new-privileges |
| 제한 | 메모리 768 MiB, PID 128 |
| 최종 관측 자원 | CPU 0.08%, 259.1 MiB / 768 MiB, PID 12 |
| 네트워크 | host mode |
| 앱 readiness | web true, DB true, bot false, botRequired false |
| 최근 오류 로그 | 최근 15분 error/exception/fatal/OOM 없음 |

QA 중 이미지가 `3c940c…`에서 `1705e2…`로 자동 교체돼 애플리케이션 QA를 최신 이미지에서 다시 수행했다.

## 3. 실제 브라우저 공개 화면

### 홈

- 제목과 기본 화면은 정상 렌더링된다.
- Discord 로그인 링크 4개가 `/auth/discord`로 연결된다.
- `announcementPopup.js`와 Socket.IO 스크립트는 로드되지만 공개 팝업 API가 404라 공지 dialog는 0개다.
- 안내 문구는 18개 상장 종목이라고 하지만 실제 통계는 10개다.
- 활동 유저가 `99,994,417,714`로 표시돼 사용자 수가 아니라 자산값을 사용한다.
- 부자 순위는 1위 `68,480,163,048원`, 2위 `99,994,417,714원`으로 표시 순서와 금액이 모순된다.

### 상점

- `/shop`은 200이고 상품·소비 기능은 렌더링된다.
- 비로그인 상태에서 잔액 `0원`, 로그인 안내 없음, 구매 버튼 13개가 모두 enabled 상태다.
- 비로그인 내비게이션에 `/admin/spending` 관리자 링크가 노출된다.
- 서버 구매 API는 올바른 Origin에서도 401 `로그인이 필요합니다.`로 차단해 인증 우회는 아니다.
- 상점에는 앱 자체 JavaScript가 없고 Cloudflare beacon만 있다. Socket.IO와 `announcementPopup.js`가 모두 누락돼 실시간·초기 공지 팝업을 표시할 수 없다.

## 4. 로그인·경제 기능 통합 QA

자동 정리 트랩이 있는 통합 시나리오 결과:

| 단계 | 결과 |
|---|---:|
| 컨테이너·헬스·migration 009 | PASS |
| 로컬 계정 가입·보안 쿠키·로그인 감지 | PASS |
| 잘못된 인증·동일 출처 방어 | PASS |
| 상점 구매·잔액·인벤토리·소각 원장 | PASS |
| 로또 구매·티켓·트랜잭션·원장 | PASS |
| 관리자 공지 생성·공개 팝업·삭제 | **FAIL** |

성공 단계의 최종 검증값은 현금 899,000원, 인벤토리 1개, 로또 티켓 1개, 경제 흐름 원장 2건이었다. 이 데이터와 임시 계정은 종료 트랩으로 삭제했다.

Discord `/admin_notice` 명령 핸들러의 DB 공지 생성은 별도 테스트에서 PASS했고 생성된 임시 공지도 즉시 삭제했다. 다만 공개 팝업 API와 상점 스크립트가 없으므로 이미 생성된 공지를 새 페이지 진입 시 팝업으로 보여주는 흐름은 실패한다. 실제 봇 프로세스의 Socket.IO 실시간 방송은 이번 모의 interaction 테스트 범위에 포함되지 않았다.

## 5. 인증 관리자 페이지

비밀값을 출력하지 않는 서명 관리자 세션으로 읽기 점검했다.

| 경로 | 결과 |
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
| `/admin/spending` | 200 |
| `/admin/admins` | 302 → `/admin/users#admin-users` |

### 관리자 API

| API | 결과 |
|---|---:|
| `GET /api/admin/announcements` | **404** |
| `POST /api/admin/announcements` | **403 CSRF 토큰 검증 실패** |
| `GET /api/announcements/popup` | **404** |
| `GET /api/admin/spending/catalog` | 200 |
| `GET /api/admin/spending/workshop` | 200 |
| `GET /api/admin/spending/ledger` | 200 |

공지 폼은 존재하지만 백엔드 라우트가 없다. `server.js`가 `adminManagementRoutes`를 `/api/admin`에도 광역 마운트해, 존재하지 않는 공지 POST가 404 대신 후순위 CSRF 미들웨어의 403으로 위장된다.

관리자 템플릿 전체에는 CSRF 토큰 참조가 0개다. CSRF 쿠키는 HttpOnly이고 토큰을 화면에 전달하는 연결도 없어 `admin-mgmt` 쓰기 UI는 정상 요청도 403이 될 수 있다.

## 6. 웹 보안 점검

### 통과 항목

- HTTP는 HTTPS로 301 리다이렉트한다.
- TLS 1.0/1.1 연결은 실패하고 TLS 1.2는 200이다.
- TRACE는 405다.
- 외부에서 악성 Host 헤더는 403이다.
- 악성 Origin에 `Access-Control-Allow-Origin`을 제공하지 않는다.
- 악성/누락 Origin의 구매·로또·확성기 POST는 403, 올바른 Origin의 비로그인 구매는 401이다.
- 비로그인 관리자 페이지/API는 403이다.
- `/.env`, `/.git/config`, package/compose/config 파일, metrics/debug 경로가 403 또는 404다.
- 인코딩된 경로 순회 시도는 400 또는 403이다.
- 로그인 실패 제한은 합성 테스트 IP에서 20회 401 후 2회 429로 동작했다.
- SQL 형태의 `limit` 입력은 파라미터로 실행되지 않고 안전한 숫자로 제한됐다.
- 관리자 서버 렌더 HTML의 사용자·로그·문의 값은 `escapeHtml`을 거친다.
- 로그 다운로드 파일명은 `path.basename`으로 제한한다.

### 보안 헤더

적용됨:

- `Cache-Control: no-store`
- `Strict-Transport-Security: max-age=15552000; includeSubDomains`
- `Content-Security-Policy: frame-ancestors 'none'`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Cross-Origin-Opener-Policy: same-origin`
- `Referrer-Policy: strict-origin-when-cross-origin`
- 위치·마이크·카메라 차단 `Permissions-Policy`
- `X-Powered-By` 미노출

CSP는 클릭재킹 방어만 있고 `default-src`, `script-src`, `object-src`, `base-uri`가 없어 XSS 발생 시 피해 제한 정책으로는 부족하다.

### 의존성

- 최신 배포 이미지의 `npm audit --offline --omit=dev`: 운영 의존성 148개, 보고된 취약점 0개.
- 이 결과는 이미지 내부 캐시 기준이다. 최신 npm 보안 DB에 패키지 목록을 보내는 온라인 audit은 외부 메타데이터 전송 승인이 없어 수행하지 않았다.

## 7. 미니PC 네트워크·DB·SSH

### 외부 포트

| 포트 | 외부 연결 | 판정 |
|---:|---:|---|
| 3306 MariaDB | **성공** | **위험** |
| 8080 운영 origin | 실패 | 정상 |
| 8085 테스트 origin | 실패 | 정상 |
| 8090 상태 서비스 | 실패 | 정상 |
| 34567 SSH | 허용 | 의도된 관리 포트 |

MariaDB는 `0.0.0.0:3306`에서 수신하고 UFW도 IPv4·IPv6 전체에 3306을 허용한다. `require_secure_transport=OFF`이며 TLS 기능만 활성화돼 강제되지 않는다. 테스트 앱 DB 계정은 `localhost` 전용이고 권한 범위도 테스트 DB로 한정돼 있었으므로 그 계정의 원격 접속은 확인되지 않았다. 다른 DB 계정의 원격 허용 여부나 비밀번호 강도는 침습적인 로그인 시도 없이 확정하지 않았다.

### SSH

- 포트 34567, root 로그인 금지
- 비밀번호 로그인 금지, 공개키 로그인 사용
- 빈 비밀번호 금지, X11 forwarding 금지
- MaxAuthTries 3
- Fail2ban sshd jail 활성, 현재 실패·차단 0

SSH 기본 설정은 양호하다. UFW는 incoming 기본 deny지만 `eno1` 전체 허용 규칙과 3306 전체 허용 규칙이 있어 실제 보호 범위를 약화한다.

## 8. 자동 테스트

| 대상 | 결과 |
|---|---|
| 로컬 워크스페이스 | 29개 발견, 28 PASS, 1 SKIP(MySQL 동시성) |
| 최신 Docker 이미지 | exit 0, **tests 0** |
| 배포 통합 QA | 1~5 PASS, 6 공지 단계 FAIL |

로컬 단위 테스트는 공지 서비스 자체를 검증하지만 실제 `server.js`와 `adminRoutes.js`의 라우트 조립 누락을 잡지 못한다. 이미지에는 테스트 파일이 포함되지 않아 `npm test`가 아무것도 검사하지 않고 성공한다.

## 9. 결함·위험 우선순위

### SEC-P0-001 — MariaDB 3306 인터넷 직접 노출

- 외부 TCP 연결 성공, `bind_address=0.0.0.0`, UFW IPv4/IPv6 전체 허용.
- TLS 전송도 강제하지 않는다.
- 즉시 3306 포트포워딩·UFW 전체 허용을 제거하고 localhost 또는 내부 VPN/관리망으로 제한해야 한다.

### FUNC-P0-002 — 관리자 공지 CRUD와 공개 팝업 API 누락

- 관리자 폼만 있고 GET 404, POST 403, 공개 API 404다.
- 홈 초기 팝업과 상점 팝업이 동작하지 않는다.
- 운영 승격을 막는 기능 회귀다.

### FUNC-P1-003 — 비로그인 상점 로그인 상태 UI 오류

- 로그인 안내 없이 구매 버튼 13개와 확성기·관리자 링크가 활성/노출된다.
- 백엔드는 401로 안전하지만 사용자는 실패 후에야 로그인 필요를 알게 된다.

### DATA-P1-004 — 홈 통계와 부자 순위 필드 매핑 오류

- 18개 문구와 실제 10개 불일치, 활동 유저에 자산값 사용, 순위 정렬과 표시 금액 모순.
- 공개 데이터 신뢰성을 훼손한다.

### ADMIN-P1-005 — CSRF 계층과 관리자 UI·라우트 조립 불일치

- `adminManagementRoutes` 광역 중복 마운트가 누락 라우트를 403으로 위장한다.
- 관리자 화면은 CSRF 토큰을 받거나 보내지 않는다.
- 중복 마운트 제거와 공통 `adminFetch` 토큰 연결이 필요하다.

### CI-P1-006 — 배포 이미지 테스트 0개 성공

- 테스트 수 최소 기준과 route smoke/E2E 게이트가 필요하다.

### ADMIN-P2-007 — 특정 사용자 감사 화면 하드코딩

- `/admin/audit` 페이지 제목과 자동 조회 대상이 특정 사용자에 고정돼 있다.
- 검색형 감사 도구, 조회 사유, 감사 로그 방식으로 바꿔야 한다.

### SEC-P2-008 — CSP 스크립트 정책 부재

- nonce/hash 기반 `script-src`, `default-src`, `object-src 'none'`, `base-uri 'self'`를 단계적으로 적용한다.

### OPS-P2-009 — QA 중 테스트 이미지 자동 교체

- 18:03 이미지에서 점검 중 18:23 이미지로 교체됐다.
- 배포 잠금과 이미지 digest 기반 QA 승인 없이는 리포트 재현성이 낮다.

### SEC-P3-010 — 직접 origin이 임의 Host를 수락

- Cloudflare는 악성 Host를 403으로 막고 앱도 HTML·OAuth에 값을 반사하지 않았다.
- 방어 심층화를 위해 앱 또는 origin 프록시에서도 허용 Host 외 요청을 400/421로 차단하는 편이 좋다.

## 10. 승격 조건

1. 관리자 공지 CRUD와 `GET /api/announcements/popup`을 복원한다.
2. 홈·상점 모두 공지 초기 조회와 Socket.IO 실시간 팝업 E2E를 통과한다.
3. MariaDB 3306 외부 허용을 제거하고 필요 시 VPN/고정 관리 IP로 한정한다.
4. 비로그인 상점 버튼을 disabled 처리하고 로그인 CTA를 표시하며 관리자 링크를 숨긴다.
5. 홈 활동 유저·순위·종목 수 쿼리와 표시 필드를 통일한다.
6. 관리자 CSRF 토큰 발급·전송을 연결하고 광역 중복 마운트를 제거한다.
7. Docker 이미지 테스트 수가 1개 미만이면 CI를 실패시키고 route smoke를 추가한다.
8. 검증할 이미지 digest를 고정한 뒤 통합 QA 전 단계 PASS와 최소 15분 안정성을 확인한다.

현재 최신 테스트 이미지는 **운영 배포 불가**다.
