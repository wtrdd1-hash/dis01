'use strict';
/**
 * 정적 페이지 HTML 템플릿 모음
 *
 * 개인정보처리방침, 이용약관, OAuth 가이드, 문의 페이지 등
 * server.js에 인라인으로 박혀 있던 대용량 HTML을 분리.
 *
 * 각 템플릿은 함수로 export되며, 필요한 변수만 인자로 받아 렌더링한다.
 */

const GTM_SCRIPT = `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
  new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
  j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
  'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
  })(window,document,'script','dataLayer','GTM-58KTJGG4');`;

const GTM_NOSCRIPT = `<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-58KTJGG4"
  height="0" width="0" style="display:none;visibility:hidden"></iframe>`;

const POLICY_STYLES = `
  :root {
    --bg: #090d16;
    --card-bg: #111827;
    --card-border: rgba(255, 255, 255, 0.08);
    --primary: #6366f1;
    --primary-hover: #4f46e5;
    --accent: #38bdf8;
    --text-main: #f8fafc;
    --text-muted: #94a3b8;
    --text-sub: #cbd5e1;
    --badge-bg: rgba(99, 102, 241, 0.15);
    --badge-border: rgba(99, 102, 241, 0.35);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background-color: var(--bg);
    color: var(--text-main);
    line-height: 1.7;
    padding-bottom: 80px;
  }
  a { color: var(--accent); text-decoration: none; transition: color 0.2s; }
  a:hover { color: #818cf8; text-decoration: underline; }
  .nav-header {
    position: sticky; top: 0; z-index: 100;
    background: rgba(9, 13, 22, 0.85); backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--card-border);
    padding: 16px 28px; display: flex; justify-content: space-between; align-items: center;
  }
  .nav-brand {
    font-family: inherit; font-size: 1.2rem; font-weight: 800; color: #fff;
    display: flex; align-items: center; gap: 10px; text-decoration: none !important;
  }
  .nav-actions { display: flex; gap: 10px; align-items: center; }
  .btn-nav {
    background: rgba(255, 255, 255, 0.06); border: 1px solid var(--card-border); color: #fff;
    padding: 8px 16px; border-radius: 10px; font-size: 0.85rem; font-weight: 600;
    cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px;
    text-decoration: none !important;
  }
  .btn-nav:hover { background: var(--primary); border-color: var(--primary-hover); transform: translateY(-1px); }
  .policy-container { max-width: 920px; margin: 40px auto 0; padding: 0 20px; }
  .policy-hero {
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(17, 24, 39, 0.9) 100%);
    border: 1px solid var(--badge-border); border-radius: 20px; padding: 36px 32px;
    margin-bottom: 30px; position: relative; overflow: hidden;
  }
  .policy-tag {
    display: inline-block; background: var(--badge-bg); border: 1px solid var(--badge-border);
    color: #c7d2fe; font-size: 0.8rem; font-weight: 700; padding: 4px 12px;
    border-radius: 20px; margin-bottom: 14px;
  }
  .policy-title { font-family: inherit; font-size: 2.1rem; font-weight: 800; color: #fff; margin-bottom: 12px; letter-spacing: -0.02em; }
  .policy-subtitle { color: var(--text-sub); font-size: 0.95rem; max-width: 720px; margin-bottom: 18px; }
  .policy-meta-row {
    display: flex; flex-wrap: wrap; gap: 16px; font-size: 0.82rem; color: var(--text-muted);
    padding-top: 14px; border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  .meta-item { display: flex; align-items: center; gap: 6px; }
  .meta-item b { color: #fff; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; padding: 24px; margin-bottom: 35px; }
  .summary-card h3 { font-size: 1.05rem; color: #fbbf24; margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
  .summary-box { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.05); padding: 14px; border-radius: 12px; }
  .summary-box-title { font-size: 0.78rem; color: var(--text-muted); margin-bottom: 4px; font-weight: 600; }
  .summary-box-desc { font-size: 0.9rem; color: #fff; font-weight: 700; }
  .toc-nav { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 35px; padding: 16px; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--card-border); border-radius: 14px; }
  .toc-pill { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); color: var(--text-sub); padding: 5px 12px; border-radius: 20px; font-size: 0.8rem; font-weight: 600; text-decoration: none !important; transition: all 0.2s; }
  .toc-pill:hover { background: rgba(99, 102, 241, 0.25); color: #fff; border-color: rgba(99, 102, 241, 0.5); }
  .policy-section { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; padding: 28px 30px; margin-bottom: 24px; scroll-margin-top: 90px; }
  .section-title { font-family: inherit; font-size: 1.25rem; font-weight: 800; color: #fff; margin-bottom: 16px; display: flex; align-items: center; gap: 10px; padding-bottom: 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
  .section-title .sec-num { background: var(--primary); color: #fff; font-size: 0.8rem; font-weight: 800; padding: 2px 8px; border-radius: 6px; }
  .policy-section p { color: var(--text-sub); font-size: 0.92rem; margin-bottom: 14px; }
  .policy-section ul, .policy-section ol { color: var(--text-sub); font-size: 0.92rem; margin-left: 20px; margin-bottom: 14px; }
  .policy-section li { margin-bottom: 8px; }
  .policy-section strong { color: #fff; font-weight: 700; }
  .policy-table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 0.85rem; }
  .policy-table th { background: rgba(0, 0, 0, 0.3); color: #94a3b8; font-weight: 700; text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--card-border); }
  .policy-table td { padding: 12px 14px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); color: var(--text-sub); vertical-align: top; }
  .policy-table tr:hover td { background: rgba(255, 255, 255, 0.02); }
  .callout-box { background: rgba(99, 102, 241, 0.08); border-left: 4px solid var(--primary); padding: 14px 18px; border-radius: 8px; margin: 16px 0; font-size: 0.88rem; color: #c7d2fe; }
  .callout-warn { background: rgba(245, 158, 11, 0.08); border-left: 4px solid #f59e0b; color: #fde68a; }
  .callout-success { background: rgba(16, 185, 129, 0.08); border-left: 4px solid #10b981; color: #a7f3d0; }
  .policy-footer { text-align: center; margin-top: 50px; padding-top: 30px; border-top: 1px solid var(--card-border); color: var(--text-muted); font-size: 0.85rem; }
  .btn-print { background: transparent; border: 1px solid var(--card-border); color: var(--text-muted); padding: 6px 14px; border-radius: 8px; font-size: 0.8rem; cursor: pointer; margin-top: 12px; transition: all 0.2s; }
  .btn-print:hover { color: #fff; border-color: #fff; }
  @media (max-width: 640px) {
    .policy-hero { padding: 24px 18px; }
    .policy-title { font-size: 1.6rem; }
    .policy-section { padding: 20px 16px; }
    .nav-header { padding: 12px 16px; }
  }
`;

function renderPrivacyPolicy(baseUrl) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <script>${GTM_SCRIPT}</script>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🔒 개인정보처리방침 | 월덕 (Duck Economy)</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@600;700;800&display=swap" rel="stylesheet">
  <style>${POLICY_STYLES}</style>
</head>
<body>
  <noscript>${GTM_NOSCRIPT}</noscript>
  <header class="nav-header">
    <a href="/" class="nav-brand"><span>🦆</span><span>월덕 경제 시스템</span></a>
    <div class="nav-actions">
      <a href="/" class="btn-nav">🏠 메인 화면</a>
      <a href="/terms" class="btn-nav">📜 서비스 이용약관</a>
    </div>
  </header>
  <main class="policy-container">
    <div class="policy-hero">
      <span class="policy-tag">Privacy Policy</span>
      <h1 class="policy-title">개인정보처리방침</h1>
      <p class="policy-subtitle">'월덕(Duck Economy)' 서비스는 정보주체의 자유와 권리 보호를 위해 「개인정보 보호법」 및 관계 법령이 정한 바를 준수하며, 이용자의 개인정보를 안전하게 처리하고 보호하기 위하여 다음과 같이 개인정보처리방침을 수립·공개합니다.</p>
      <div class="policy-meta-row">
        <div class="meta-item">📅 <b>시행일자:</b> 2026년 8월 15일</div>
        <div class="meta-item">🔄 <b>최종 개정일:</b> 2026년 8월 15일</div>
        <div class="meta-item">🌐 <b>적용 대상:</b> 디스코드 봇 및 웹 애플리케이션 전 서비스</div>
      </div>
    </div>
    <div class="summary-card">
      <h3>📌 개인정보 처리 핵심 요약</h3>
      <div class="summary-grid">
        <div class="summary-box"><div class="summary-box-title">수집 항목</div><div class="summary-box-desc">Discord ID, 닉네임, 아바타</div></div>
        <div class="summary-box"><div class="summary-box-title">수집 목적</div><div class="summary-box-desc">계정 식별, 게임 자산 저장, 1:1 문의</div></div>
        <div class="summary-box"><div class="summary-box-title">보유 기간</div><div class="summary-box-desc">탈퇴 시 즉시 파기 (로그 30일)</div></div>
        <div class="summary-box"><div class="summary-box-title">제3자 제공</div><div class="summary-box-desc" style="color: #34d399;">일체 없음 (None)</div></div>
      </div>
    </div>
    <nav class="toc-nav">
      <a href="#sec-1" class="toc-pill">1. 수집 목적</a>
      <a href="#sec-2" class="toc-pill">2. 수집 항목 및 방법</a>
      <a href="#sec-3" class="toc-pill">3. 보유 및 이용기간</a>
      <a href="#sec-4" class="toc-pill">4. 제3자 제공 및 위탁</a>
      <a href="#sec-5" class="toc-pill">5. 이용자의 권리 및 행사</a>
      <a href="#sec-6" class="toc-pill">6. 파기 절차 및 방법</a>
      <a href="#sec-7" class="toc-pill">7. 안전성 확보 조치</a>
      <a href="#sec-8" class="toc-pill">8. 쿠키(Cookie) 운영</a>
      <a href="#sec-9" class="toc-pill">9. 보호책임자 및 문의처</a>
      <a href="#sec-10" class="toc-pill">10. 방침의 변경 및 고지</a>
    </nav>
    <section id="sec-1" class="policy-section">
      <h2 class="section-title"><span class="sec-num">제1조</span> 개인정보의 수집 및 이용 목적</h2>
      <p>서비스는 다음의 목적을 위하여 최소한의 개인정보를 수집 및 처리합니다. 처리하고 있는 개인정보는 다음의 목적 이외의 용도로는 이용되지 않으며, 이용 목적이 변경되는 경우에는 관련 법령에 따라 별도의 동의를 받는 등 필요한 조치를 이행할 예정입니다.</p>
      <ul>
        <li><strong>1. 디스코드(Discord) 계정 연동 및 본인 식별:</strong> Discord OAuth2 로그인을 통한 고유 회원 식별, 중복 가입 방지, 계정 인증 관리</li>
        <li><strong>2. 게임 및 경제 시스템 데이터 관리:</strong> 가상 현금, 은행 예금, 주식 포트폴리오, 광산 클리커 레벨, 출석체크 및 랭킹 데이터의 안전한 저장 및 유지</li>
        <li><strong>3. 1:1 고객센터 문의 접수 및 답변 처리:</strong> 사용자의 버그 제보, 기능 건의, 계정 복구 문의 접수 및 디스코드 관리자 DM을 통한 신속한 답변 회신</li>
        <li><strong>4. 부정 이용 방지 및 서비스 안정성 감사:</strong> 매크로/어뷰징 방지, 시스템 오류 추적, 접속 트래픽 분석 및 무단 침입 방지</li>
      </ul>
    </section>
    <section id="sec-2" class="policy-section">
      <h2 class="section-title"><span class="sec-num">제2조</span> 수집하는 개인정보의 항목 및 수집 방법</h2>
      <p>서비스는 회원가입 및 서비스 이용 과정에서 다음과 같은 개인정보를 수집합니다.</p>
      <table class="policy-table">
        <thead><tr><th>구분</th><th>수집 항목</th><th>수집 목적 및 방법</th></tr></thead>
        <tbody>
          <tr><td><strong>필수 항목 (기본)</strong></td><td>Discord 고유 ID (User ID), Discord 사용자명(Username), 프로필 아바타 이미지 URL</td><td>Discord OAuth2 로그인 시 이용자 동의를 거쳐 디스코드 API를 통해 자동 연동</td></tr>
          <tr><td><strong>선택 항목 (고객센터)</strong></td><td>1:1 문의 제목, 문의 내용, 첨부 이미지/스크린샷</td><td>웹 1:1 문의 폼 또는 디스코드 <code>/문의</code> 명령어 작성 시 이용자가 직접 제출</td></tr>
          <tr><td><strong>자동 수집 항목</strong></td><td>접속 IP 주소, 브라우저 User-Agent, 서비스 이용 기록(명령어 실행 및 웹 요청 로그)</td><td>웹 서버 및 디스코드 봇 상호작용 시 시스템 로그를 통해 자동 생성 및 수집</td></tr>
        </tbody>
      </table>
      <div class="callout-box">💡 <strong>민감정보 수집 금지:</strong> 서비스는 이용자의 실명, 주민등록번호, 전화번호, 실제 금융 계좌번호, 결제 정보 등 일체의 민감한 개인정보를 수집하거나 요구하지 않습니다.</div>
    </section>
    <section id="sec-3" class="policy-section">
      <h2 class="section-title"><span class="sec-num">제3조</span> 개인정보의 보유 및 이용 기간</h2>
      <p>서비스는 법령에 따른 개인정보 보유·이용 기간 또는 정보주체로부터 개인정보를 수집 시에 동의받은 개인정보 보유·이용 기간 내에서 개인정보를 처리·보유합니다.</p>
      <ul>
        <li><strong>계정 및 가상 자산 정보:</strong> 서비스 이용 계약(디스코드 봇 사용 또는 웹 연동) 유지 기간 동안 보유하며, 회원 탈퇴 또는 데이터 삭제 요청 시 지체 없이 영구 파기합니다.</li>
        <li><strong>시스템 접속 및 명령어 감사 로그:</strong> 악의적 어뷰징 방지 및 시스템 안정성 관리를 위해 <strong>30일간</strong> 보관 후, 백그라운드 자동 스케줄러를 통해 30일이 초과된 데이터는 영구 자동 파기됩니다.</li>
        <li><strong>1:1 고객센터 상담 내역:</strong> 고객 분쟁 해결 및 상담 이력 확인을 위해 최대 <strong>1년간</strong> 보관 후 안전하게 파기됩니다.</li>
      </ul>
    </section>
    <section id="sec-4" class="policy-section">
      <h2 class="section-title"><span class="sec-num">제4조</span> 개인정보의 제3자 제공 및 위탁</h2>
      <p>서비스는 정보주체의 개인정보를 제1조(개인정보의 수집 및 이용 목적)에서 명시한 범위 내에서만 처리하며, 정보주체의 동의 없이 본래의 범위를 초과하여 처리하거나 <strong>제3자에게 제공 및 위탁하지 않습니다.</strong></p>
      <div class="callout-box callout-success">✅ <strong>제3자 제공 내역 없음:</strong> 본 서비스는 영리 목적의 타사 광고 제공, 데이터 판매, 외부 마케팅 위탁을 일체 진행하지 않습니다.</div>
      <p style="font-size: 0.85rem; color: var(--text-muted);">※ 단, 법률에 특별한 규정이 있거나 법령상 의무를 준수하기 위하여 불가피하게 수사기관 등의 적법한 요청이 있는 경우에는 예외로 합니다.</p>
    </section>
    <section id="sec-5" class="policy-section">
      <h2 class="section-title"><span class="sec-num">제5조</span> 정보주체 및 법정대리인의 권리·의무 및 행사 방법</h2>
      <p>정보주체는 서비스에 대해 언제든지 다음 각 호의 개인정보 보호 관련 권리를 행사할 수 있습니다.</p>
      <ol>
        <li><strong>개인정보 열람 및 자산 조회:</strong> 메인 웹사이트 상단 프로필 모달 및 디스코드 <code>/지갑</code>, <code>/포트폴리오</code> 명령어를 통해 실시간 데이터 확인 가능</li>
        <li><strong>Discord 연동 해제 (승인 취소):</strong> Discord 앱 설정 ➔ [승인된 앱(Authorized Apps)] 메뉴에서 '월덕' 애플리케이션의 권한을 언제든 직접 즉시 취소 가능</li>
        <li><strong>계정 및 데이터 영구 삭제(탈퇴) 요청:</strong> 1:1 고객센터 문의 창구 또는 디스코드 <code>/문의</code> 명령어를 통해 본인 확인 후 모든 데이터의 즉시 파기를 요청하실 수 있습니다.</li>
      </ol>
    </section>
    <section id="sec-6" class="policy-section">
      <h2 class="section-title"><span class="sec-num">제6조</span> 개인정보의 파기 절차 및 파기 방법</h2>
      <p>서비스는 개인정보 보유기간의 경과, 처리목적 달성 등 개인정보가 불필요하게 되었을 때에는 지체 없이 해당 개인정보를 파기합니다.</p>
      <ul>
        <li><strong>파기 절차:</strong> 파기 사유가 발생한 개인정보를 선정하고, 관리자의 승인을 거쳐 데이터베이스에서 즉시 삭제 조치합니다.</li>
        <li><strong>파기 방법:</strong> 전자적 파일 형태의 정보는 기록을 재생할 수 없는 기술적 방법(SQL DELETE 및 스토리지 영구 삭제)을 사용하여 파기합니다.</li>
      </ul>
    </section>
    <section id="sec-7" class="policy-section">
      <h2 class="section-title"><span class="sec-num">제7조</span> 개인정보의 안전성 확보 조치</h2>
      <p>서비스는 개인정보의 안전성 확보를 위해 다음과 같은 기술적·관리적 조치를 취하고 있습니다.</p>
      <ul>
        <li><strong>1. 통신 구간 암호화:</strong> HTTPS(SSL/TLS) 보안 프로토콜을 적용하여 데이터 송수신 시 도청 및 위변조를 방지합니다.</li>
        <li><strong>2. 안전한 세션 쿠키 보호:</strong> 로그인 인증 토큰은 <code>HttpOnly</code> 및 보안 속성이 적용된 쿠키로 격리하여 XSS 공격 및 스크립트 탈취를 원천 차단합니다.</li>
        <li><strong>3. 권한 관리 및 접근 통제:</strong> 데이터베이스 및 관리자 페이지에 대한 접근 권한을 관리자 Discord ID 화이트리스트로 엄격히 제한합니다.</li>
        <li><strong>4. 첨부 파일 격리 및 정제:</strong> 1:1 문의 시 첨부되는 이미지 파일은 확장자 및 Base64 바이너리 검증을 거쳐 독립된 격리 스토리지에 안전하게 보관됩니다.</li>
      </ul>
    </section>
    <section id="sec-8" class="policy-section">
      <h2 class="section-title"><span class="sec-num">제8조</span> 개인정보 자동 수집 장치의 설치·운영 및 거부에 관한 사항</h2>
      <p>서비스는 이용자에게 개별적인 맞춤 서비스를 제공하기 위해 이용 정보를 저장하고 수시로 불러오는 <strong>'쿠키(Cookie)'</strong>를 사용합니다.</p>
      <ul>
        <li><strong>쿠키의 사용 목적:</strong> Discord 로그인 상태 유지 및 세션 인증 (<code>discord_user</code> 쿠키)</li>
        <li><strong>쿠키 설치 거부 방법:</strong> 웹 브라우저의 옵션 설정을 통해 쿠키 저장을 거부할 수 있습니다. 단, 쿠키 저장을 거부할 경우 웹 애플리케이션 로그인 및 마이페이지 이용에 제한이 있을 수 있습니다.</li>
      </ul>
    </section>
    <section id="sec-9" class="policy-section">
      <h2 class="section-title"><span class="sec-num">제9조</span> 개인정보 보호책임자 및 1:1 고객센터 창구</h2>
      <p>서비스는 개인정보 처리에 관한 업무를 총괄해서 책임지고, 개인정보 처리와 관련한 정보주체의 불만처리 및 피해구제 등을 위하여 아래와 같이 고객 지원 창구를 운영하고 있습니다.</p>
      <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--card-border); padding: 18px 20px; border-radius: 12px; margin-top: 12px;">
        <p style="margin-bottom: 6px;"><strong>🛡️ 개인정보 보호 및 고객 지원팀:</strong> 월덕(Duck Economy) 운영진</p>
        <p style="margin-bottom: 6px;"><strong>💬 디스코드 1:1 문의 명령어:</strong> <code>/문의</code></p>
        <p style="margin-bottom: 6px;"><strong>🌐 웹 1:1 고객센터:</strong> <a href="/#support">메인 화면 하단 1:1 문의 창구</a></p>
        <p style="margin-bottom: 0;"><strong>⚡ 관리자 다이렉트 소통:</strong> 문의 접수 시 관리자 디스코드 DM으로 실시간 전송 후 즉시 답변</p>
      </div>
    </section>
    <section id="sec-10" class="policy-section">
      <h2 class="section-title"><span class="sec-num">제10조</span> 개인정보처리방침의 변경 및 고지 의무</h2>
      <p>본 개인정보처리방침은 <strong>2026년 8월 15일</strong>부터 적용됩니다. 법령 및 방침에 따른 변경내용의 추가, 삭제 및 정정이 있는 경우에는 변경사항의 시행 7일 전부터 웹사이트 공지사항 또는 디스코드 봇 알림을 통하여 고지할 것입니다.</p>
    </section>
    <footer class="policy-footer">
      <p>© 2026 Duck Economy Project. All rights reserved.</p>
      <p style="margin-top: 4px; font-size: 0.78rem;">공식 웹 주소: <a href="${baseUrl}/privacy">${baseUrl}/privacy</a></p>
      <button type="button" class="btn-print" onclick="window.print()">🖨️ 개인정보처리방침 인쇄하기</button>
    </footer>
  </main>
</body>
</html>`;
}

function renderTermsOfService(baseUrl) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <script>${GTM_SCRIPT}</script>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>📜 서비스 이용약관 (Terms of Service) | 월덕 (WTRD)</title>
  <meta name="description" content="월덕 (WTRD) 디스코드 가상 경제, 주식 차트, 아케이드 미니게임 플랫폼의 공식 서비스 이용약관입니다.">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${baseUrl}/terms">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #07090e; --card-bg: #0f172a; --card-border: rgba(255, 255, 255, 0.08);
      --primary: #6366f1; --accent: #38bdf8; --warning: #fbbf24; --danger: #f87171; --success: #34d399;
      --text-main: #f8fafc; --text-muted: #94a3b8; --text-sub: #cbd5e1;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Noto Sans KR', 'Pretendard', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
    body { background-color: var(--bg); color: var(--text-main); line-height: 1.7; padding-bottom: 90px; }
    a { color: var(--accent); text-decoration: none; }
    .nav-header { position: sticky; top: 0; z-index: 100; background: rgba(7, 9, 14, 0.88); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border-bottom: 1px solid var(--card-border); padding: 16px 28px; display: flex; justify-content: space-between; align-items: center; }
    .nav-brand { font-size: 1.25rem; font-weight: 900; color: #fff; display: flex; align-items: center; gap: 10px; }
    .btn-nav { background: rgba(255, 255, 255, 0.06); border: 1px solid var(--card-border); color: #fff; padding: 8px 16px; border-radius: 8px; font-size: 0.88rem; font-weight: 700; cursor: pointer; transition: all 0.2s; }
    .btn-nav:hover { background: var(--primary); }
    .policy-container { max-width: 960px; margin: 40px auto 0; padding: 0 20px; }
    .policy-hero { background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(15, 23, 42, 0.95) 100%); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 20px; padding: 36px 32px; margin-bottom: 30px; }
    .policy-title { font-size: 2.2rem; font-weight: 900; color: #fff; margin-bottom: 12px; }
    .policy-section { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; padding: 28px 30px; margin-bottom: 24px; }
    .section-title { font-size: 1.3rem; font-weight: 800; color: #fff; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
    .sec-num { color: var(--primary); margin-right: 6px; }
    .policy-section p, .policy-section li { color: var(--text-sub); font-size: 0.95rem; margin-bottom: 10px; }
    .policy-section ul, .policy-section ol { margin-left: 22px; margin-bottom: 14px; }
    .callout-box { background: rgba(99, 102, 241, 0.08); border: 1px solid rgba(99, 102, 241, 0.25); border-radius: 12px; padding: 18px 20px; margin: 16px 0; font-size: 0.92rem; color: #cbd5e1; }
    .callout-danger { background: rgba(239, 68, 68, 0.08); border-color: rgba(239, 68, 68, 0.3); color: #fca5a5; }
    .callout-success { background: rgba(16, 185, 129, 0.08); border-color: rgba(16, 185, 129, 0.3); color: #86efac; }
    .policy-footer { text-align: center; margin-top: 50px; padding-top: 30px; border-top: 1px solid var(--card-border); color: var(--text-muted); font-size: 0.88rem; }
    .btn-print { background: rgba(255, 255, 255, 0.08); border: 1px solid var(--card-border); color: #fff; padding: 10px 20px; border-radius: 10px; font-weight: 700; cursor: pointer; margin-top: 14px; }
    .btn-print:hover { background: rgba(255, 255, 255, 0.15); }
  </style>
</head>
<body>
  <noscript>${GTM_NOSCRIPT}</noscript>
  <header class="nav-header">
    <a href="/" class="nav-brand"><span>🦆</span><span>월덕 (WTRD)</span></a>
    <div style="display:flex; gap:10px;">
      <a href="/" class="btn-nav">🏠 메인 화면</a>
      <a href="/privacy" class="btn-nav">🔒 개인정보처리방침</a>
    </div>
  </header>
  <main class="policy-container">
    <div class="policy-hero">
      <h1 class="policy-title">서비스 이용약관</h1>
      <p style="color: var(--text-sub); font-size: 1rem;">월덕(WTRD / Duck Economy) 디스코드 봇 및 웹 애플리케이션 서비스를 이용해 주셔서 감사합니다. 본 약관은 서비스 이용에 관한 운영진과 이용자의 권리·의무 및 책임사항을 규정합니다.</p>
      <p style="font-size:0.85rem; color:var(--text-muted); margin-top:12px;">📅 최종 시행일자: 2026년 8월 18일</p>
    </div>
    <section class="policy-section">
      <h2 class="section-title"><span class="sec-num">제1조</span> (목적 및 서비스 정의)</h2>
      <p>본 약관은 '월덕 운영팀'(이하 "운영진")이 제공하는 디스코드 가상 경제, 주식 차트 시뮬레이션, 광산 채굴 및 아케이드 미니게임 웹·봇 서비스(이하 "서비스")의 이용조건 및 절차에 관한 제반 사항을 규정함을 목적으로 합니다.</p>
      <div class="callout-box callout-danger">
        ⚠️ <strong>가상 데이터 및 환전 불가 원칙:</strong><br>
        본 서비스 내에서 유통되는 모든 화폐(원), 주식 종목, 채굴 재화, 미니게임 포인트는 <b>Discord 커뮤니티 전용 100% 무료 가상 데이터</b>입니다.<br>
        어떠한 경우에도 <b>실제 현금, 계좌 이체, 암호화폐, 유가증권, 현물 상품권 등으로 환전·환급·결제되지 않으며, 실물 재산적 가치가 전혀 없습니다.</b>
      </div>
    </section>
    <section class="policy-section">
      <h2 class="section-title"><span class="sec-num">제2조</span> (이용계약의 성립 및 로그인)</h2>
      <p>1. 이용계약은 이용자가 Discord 계정을 통해 서비스에 접속하거나, 웹사이트에서 계정을 생성하여 본 약관에 동의함으로써 체결됩니다.</p>
      <p>2. 만 14세 미만의 아동은 Discord 이용약관 및 법률에 따라 본 서비스를 이용할 수 없습니다.</p>
      <p>3. 운영진은 다음 각 호에 해당하는 경우 이용 신청을 거부하거나 사후에 이용을 제한할 수 있습니다.</p>
      <ul>
        <li>타인의 Discord 계정 또는 명의를 도용한 경우</li>
        <li>사회적 안녕질서 또는 미풍양속을 저해할 목적으로 신청한 경우</li>
        <li>부정한 용도나 악의적 매크로/해킹 공격을 위해 서비스를 이용하는 경우</li>
      </ul>
    </section>
    <section class="policy-section">
      <h2 class="section-title"><span class="sec-num">제3조</span> (이용자의 의무 및 금지 행위)</h2>
      <p>이용자는 서비스 이용 시 다음 각 호의 행위를 하여서는 안 되며, 적발 시 <b>사전 경고 없이 계정 영구 정지, 자산 몰수, Discord 서버 밴</b> 등의 강력한 제재가 가해집니다.</p>
      <ol>
        <li><strong>현금 거래(RMT) 금지:</strong> 가상 화폐, 주식, 아이템을 실제 현금, 기프티콘, 암호화폐, 타 플랫폼 재화와 유상 거래하거나 알선·시도하는 일체의 행위</li>
        <li><strong>시스템 취약점 악용:</strong> 버그, 시스템 오류, 동시성 취약점을 고의로 악용하여 비정상적으로 자산을 증식·복제하는 행위</li>
        <li><strong>자동화 매크로 및 비정상 트래픽:</strong> 비공식 스크립트, 다중 봇 계정, DDoS 공격 등을 통해 서버에 과부하를 유발하는 행위</li>
        <li><strong>타인 계정 및 개인정보 침해:</strong> 타인의 계정을 무단 접속하거나 개인정보를 탈취하는 행위</li>
        <li><strong>고객센터 및 광장 어뷰징:</strong> 1:1 고객센터 창구나 광장 채팅에 음란물, 악성코드 링크, 욕설/명예훼손 콘텐츠를 게시하는 행위</li>
      </ol>
    </section>
    <section class="policy-section">
      <h2 class="section-title"><span class="sec-num">제4조</span> (서비스의 제공, 변경 및 롤백)</h2>
      <p>1. 서비스는 연중무휴, 1일 24시간 제공을 원칙으로 합니다.</p>
      <p>2. 운영진은 시스템 정기점검, 보안 패치, 긴급 버그 수정, 새로운 콘텐츠 업데이트가 필요한 경우 사전 공지 후 서비스의 일부 또는 전부를 일시 중단할 수 있습니다.</p>
      <p>3. 치명적인 버그 악용이나 데이터베이스 오염이 발생한 경우, 경제 생태계의 안정성을 위해 운영진의 판단에 따라 <b>데이터 롤백(특정 시점으로의 복원) 및 부당 이득 몰수 조치</b>를 취할 수 있습니다.</p>
    </section>
    <section class="policy-section">
      <h2 class="section-title"><span class="sec-num">제5조</span> (지식재산권 및 저작권)</h2>
      <p>1. 서비스 내의 모든 UI 디자인, 캐릭터 그래픽, 소스코드, 시스템 알고리즘에 대한 지식재산권은 월덕 운영팀에 귀속됩니다.</p>
      <p>2. 이용자는 서비스를 이용함으로써 얻은 정보를 운영진의 사전 승낙 없이 복제, 배포, 상업적 이용할 수 없습니다.</p>
    </section>
    <section class="policy-section">
      <h2 class="section-title"><span class="sec-num">제6조</span> (면책 조항)</h2>
      <p>1. 운영진은 천재지변, 디스코드(Discord Inc.) 본사 서버 장애, Cloudflare 통신 장애 등 불가항력적 사유로 인하여 서비스를 제공할 수 없는 경우에는 책임을 면합니다.</p>
      <p>2. 운영진은 이용자의 귀책사유로 인한 서비스 이용 장애나 가상 자산의 손실(주식 시세 변동, 게임 실패 등)에 대하여 책임을 지지 않습니다.</p>
      <p>3. 본 서비스의 주식 시세와 차트는 알고리즘에 의한 가상 시뮬레이션이며, 실제 주식 시장이나 유가증권 거래와는 아무런 관련이 없습니다.</p>
    </section>
    <section class="policy-section">
      <h2 class="section-title"><span class="sec-num">제7조</span> (분쟁 해결 및 고객 지원)</h2>
      <p>서비스 이용 중 발생하는 문의사항, 버그 제보, 권리 침해 신고는 아래의 창구를 통해 실시간으로 접수하여 해결합니다.</p>
      <div class="callout-box callout-success">
        💬 <b>1:1 고객센터 창구:</b> 메인 웹 사이트 하단 [1:1 문의] 또는 디스코드 <code>/문의</code> 명령어<br>
        🛡️ <b>운영 및 고객지원:</b> 월덕(WTRD) 운영팀 (Discord 관리자 다이렉트 소통)
      </div>
    </section>
    <footer class="policy-footer">
      <p>© 2026 월덕 (WTRD) 커뮤니티 가상 경제 프로젝트. All rights reserved.</p>
      <p style="margin-top: 6px; font-size: 0.82rem;">공식 웹 주소: <a href="${baseUrl}/terms">${baseUrl}/terms</a></p>
      <button type="button" class="btn-print" onclick="window.print()">🖨️ 이용약관 인쇄하기</button>
    </footer>
  </main>
</body>
</html>`;
}

function renderOAuthGuide(redirectUri) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>Discord OAuth 설정 안내</title>
  <style>
    body { font-family: sans-serif; background: #0b0f19; color: #c9d1d9; padding: 40px; display: flex; justify-content: center; }
    .card { background: #161b22; border: 1px solid #30363d; padding: 30px; border-radius: 16px; max-width: 600px; }
    h1 { color: #58a6ff; }
    code { background: #0d1117; color: #79c0ff; padding: 4px 8px; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚙️ Discord OAuth2 리디렉션 URI 설정 방법</h1>
    <p>Discord OAuth2 인증을 작동시키려면 디스코드 개발자 포털에 아래 리디렉션 URI를 등록해야 합니다:</p>
    <br>
    <p><b>1. Discord Developer Portal 접속</b> -> 애플리케이션 선택</p>
    <p><b>2. OAuth2 메뉴 -> Redirects 섹션</b> 이동</p>
    <p><b>3. Add Redirect 클릭 후 아래 URI 추가:</b></p>
    <p><code>${redirectUri}</code></p>
    <br>
    <a href="/" style="color:#58a6ff;">← 메인 페이지로 돌아가기</a>
  </div>
</body>
</html>`;
}

module.exports = {
  renderPrivacyPolicy,
  renderTermsOfService,
  renderOAuthGuide
};