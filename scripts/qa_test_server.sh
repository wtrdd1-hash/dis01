#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${TEST_CONTAINER:-wtrdd-test-app}"
BASE_URL="${TEST_BASE_URL:-http://127.0.0.1:8085}"
PUBLIC_HOST="test.easy-scraping.com"
PUBLIC_ORIGIN="https://test.easy-scraping.com"
qa_tmp="$(mktemp -d)"
qa_user_id=""
qa_notice_id=""

cleanup() {
  set +e
  if [[ -n "${qa_user_id:-}" ]]; then
    docker exec -e QA_USER_ID="$qa_user_id" "$CONTAINER" node -e '
      const { pool } = require("./src/config/database");
      (async () => {
        const id = process.env.QA_USER_ID;
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          const [tickets] = await connection.query("SELECT round_number, COUNT(*) AS count FROM lotto_tickets WHERE user_id = ? GROUP BY round_number", [id]);
          await connection.query("DELETE FROM lotto_tickets WHERE user_id = ?", [id]);
          for (const ticket of tickets) {
            const count = BigInt(ticket.count || 0);
            await connection.query("UPDATE lotto_rounds SET total_sales = GREATEST(0, total_sales - ?), total_burned = GREATEST(0, total_burned - ?), jackpot_pool = GREATEST(0, jackpot_pool - ?) WHERE round_number = ?", [(count * 1000n).toString(), (count * 300n).toString(), (count * 700n).toString(), ticket.round_number]);
          }
          await connection.query("DELETE FROM user_inventory WHERE user_id = ?", [id]);
          await connection.query("DELETE FROM user_drill_equipment WHERE user_id = ?", [id]);
          await connection.query("DELETE FROM economy_flow_logs WHERE user_id = ? OR target_user_id = ?", [id, id]);
          await connection.query("DELETE FROM economy_logs WHERE user_id = ?", [id]);
          await connection.query("DELETE FROM web_accounts WHERE user_id = ?", [id]);
          await connection.query("DELETE FROM users WHERE discord_id = ?", [id]);
          await connection.commit();
        } catch (err) {
          await connection.rollback();
          throw err;
        } finally {
          connection.release();
          await pool.end();
        }
      })().catch((err) => { console.error(err.message); process.exit(1); });
    '
  fi
  if [[ -n "${qa_notice_id:-}" ]]; then
    docker exec -e QA_NOTICE_ID="$qa_notice_id" "$CONTAINER" node -e '
      const { pool } = require("./src/config/database");
      pool.query("DELETE FROM site_announcements WHERE id = ?", [process.env.QA_NOTICE_ID])
        .finally(() => pool.end());
    ' >/dev/null 2>&1
  fi
  rm -rf -- "$qa_tmp"
}
trap cleanup EXIT

json_value() {
  local expression="$1"
  docker exec -i -e QA_EXPRESSION="$expression" "$CONTAINER" node -e '
    let body = "";
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const value = Function("data", "return (" + process.env.QA_EXPRESSION + ")")(JSON.parse(body));
      if (value === undefined || value === null) process.exit(2);
      process.stdout.write(String(value));
    });
  '
}

request_json() {
  local method="$1"
  local path="$2"
  local body="$3"
  local cookie="${4:-}"
  local output="$5"
  local headers="$6"
  local args=(-sS -D "$headers" -o "$output" -w '%{http_code}' -X "$method" "$BASE_URL$path"
    -H "Host: $PUBLIC_HOST" -H "Origin: $PUBLIC_ORIGIN" -H 'X-Forwarded-Proto: https'
    -H 'Content-Type: application/json')
  if [[ -n "$cookie" ]]; then args+=(-H "Cookie: $cookie"); fi
  if [[ -n "$body" ]]; then args+=(--data "$body"); fi
  curl "${args[@]}"
}

echo '[QA 1/8] 컨테이너, 헬스, 마이그레이션 스키마 확인'
docker inspect -f '{{.State.Status}} {{.State.Health.Status}} {{.Config.User}} {{.HostConfig.ReadonlyRootfs}}' "$CONTAINER" | grep -q '^running healthy 1000:1000 true$'
curl -fsS "$BASE_URL/readyz" | json_value 'data.ok === true && data.db === true && data.bot === false && data.botRequired === false' | grep -q true
docker exec "$CONTAINER" node -e '
  const { pool } = require("./src/config/database");
  (async () => {
    const [columns] = await pool.query("SHOW COLUMNS FROM economy_flow_logs");
    const names = new Set(columns.map((row) => row.Field));
    for (const required of ["flow_type", "category", "user_id", "target_user_id", "balance_after", "metadata", "created_at"]) {
      if (!names.has(required)) throw new Error("missing column: " + required);
    }
    const [migrations] = await pool.query("SELECT version FROM _schema_migrations WHERE version = ?", ["009"]);
    if (!migrations.length) throw new Error("migration 009 not recorded");
    console.log("schema=ok migration=009");
  })().finally(() => pool.end()).catch((err) => { console.error(err.message); process.exit(1); });
'

echo '[QA 2/8] 로컬 계정 가입, 보안 쿠키, 로그인 감지 확인'
qa_name="qa$(date +%H%M%S)"
qa_password="Qa$(date +%s)Safe"
register_status="$(request_json POST /auth/local/register "{\"username\":\"$qa_name\",\"password\":\"$qa_password\"}" '' "$qa_tmp/register.json" "$qa_tmp/register.headers")"
[[ "$register_status" == '200' ]]
grep -qi '^set-cookie: web_user_test=' "$qa_tmp/register.headers"
grep -qi '^set-cookie: web_user_test=.*HttpOnly' "$qa_tmp/register.headers"
grep -qi '^set-cookie: web_user_test=.*Secure' "$qa_tmp/register.headers"
grep -qi '^set-cookie: web_user_test=.*SameSite=Lax' "$qa_tmp/register.headers"
if grep -qi '^set-cookie: web_user_test=.*Domain=' "$qa_tmp/register.headers"; then
  echo '테스트 로그인 쿠키에 Domain 속성이 있어 운영 쿠키와 격리되지 않았습니다.' >&2
  exit 1
fi
qa_cookie="$(sed -n 's/^set-cookie: \(web_user_test=[^;]*\).*/\1/ip' "$qa_tmp/register.headers" | head -n 1 | tr -d '\r')"
[[ -n "$qa_cookie" ]]
curl -fsS "$BASE_URL/api/user/me" -H "Host: $PUBLIC_HOST" -H 'X-Forwarded-Proto: https' -H "Cookie: $qa_cookie" > "$qa_tmp/me.json"
json_value 'data.success === true && data.loggedIn === true && data.local === true && data.discord === false' < "$qa_tmp/me.json" | grep -q true
qa_user_id="$(json_value 'data.user.id' < "$qa_tmp/me.json")"
[[ "$qa_user_id" =~ ^w_[a-f0-9]{16}$ ]]

login_status="$(request_json POST /auth/local/login "{\"username\":\"$qa_name\",\"password\":\"$qa_password\"}" '' "$qa_tmp/login.json" "$qa_tmp/login.headers")"
[[ "$login_status" == '200' ]]
qa_login_cookie="$(sed -n 's/^set-cookie: \(web_user_test=[^;]*\).*/\1/ip' "$qa_tmp/login.headers" | head -n 1 | tr -d '\r')"
curl -fsS "$BASE_URL/api/user/me" -H "Host: $PUBLIC_HOST" -H 'X-Forwarded-Proto: https' -H "Cookie: $qa_login_cookie" > "$qa_tmp/me-login.json"
json_value 'data.loggedIn === true && data.user.id === "'"$qa_user_id"'"' < "$qa_tmp/me-login.json" | grep -q true

echo '[QA 3/8] 인증 실패와 동일 출처 방어 확인'
bad_status="$(request_json POST /auth/local/login "{\"username\":\"$qa_name\",\"password\":\"wrong-password\"}" '' "$qa_tmp/bad-login.json" "$qa_tmp/bad-login.headers")"
[[ "$bad_status" == '401' ]]
csrf_status="$(curl -sS -o "$qa_tmp/csrf.json" -w '%{http_code}' -X POST "$BASE_URL/api/shop/buy" -H "Host: $PUBLIC_HOST" -H 'X-Forwarded-Proto: https' -H "Cookie: $qa_cookie" -H 'Content-Type: application/json' --data '{"itemKey":"aura_cyberpunk"}')"
[[ "$csrf_status" == '403' ]]

echo '[QA 4/8] 상점 구매 및 잔액·인벤토리·소각 원장 확인'
docker exec -e QA_USER_ID="$qa_user_id" "$CONTAINER" node -e '
  const { pool } = require("./src/config/database");
  pool.query("UPDATE users SET cash = ? WHERE discord_id = ?", ["1000000", process.env.QA_USER_ID]).finally(() => pool.end());
'
shop_status="$(request_json POST /api/shop/buy '{"itemKey":"aura_cyberpunk"}' "$qa_cookie" "$qa_tmp/shop.json" "$qa_tmp/shop.headers")"
if [[ "$shop_status" != '200' ]]; then
  echo "상점 구매 HTTP $shop_status: $(tr -d '\r\n' < "$qa_tmp/shop.json")" >&2
  exit 1
fi
json_value 'data.success === true && data.afterCash === "900000"' < "$qa_tmp/shop.json" | grep -q true

echo '[QA 5/8] 로또 구매 및 트랜잭션 결과 확인'
lotto_status="$(request_json POST /api/lotto/buy '{"numbers":[1,2,3,4,5,6],"isAuto":false}' "$qa_cookie" "$qa_tmp/lotto.json" "$qa_tmp/lotto.headers")"
if [[ "$lotto_status" != '200' ]]; then
  echo "로또 구매 HTTP $lotto_status: $(tr -d '\r\n' < "$qa_tmp/lotto.json")" >&2
  exit 1
fi
json_value 'data.success === true && data.afterCash === "899000" && data.ticket.numberStr === "1,2,3,4,5,6"' < "$qa_tmp/lotto.json" | grep -q true
docker exec -e QA_USER_ID="$qa_user_id" "$CONTAINER" node -e '
  const { pool } = require("./src/config/database");
  (async () => {
    const id = process.env.QA_USER_ID;
    const [[user]] = await pool.query("SELECT cash FROM users WHERE discord_id = ?", [id]);
    const [[inventory]] = await pool.query("SELECT COUNT(*) AS count FROM user_inventory WHERE user_id = ? AND item_key = ?", [id, "aura_cyberpunk"]);
    const [[tickets]] = await pool.query("SELECT COUNT(*) AS count FROM lotto_tickets WHERE user_id = ?", [id]);
    const [flows] = await pool.query("SELECT category, amount, balance_after FROM economy_flow_logs WHERE user_id = ? ORDER BY id", [id]);
    if (String(user.cash) !== "899000") throw new Error("cash mismatch");
    if (Number(inventory.count) !== 1 || Number(tickets.count) !== 1) throw new Error("purchase rows mismatch");
    if (flows.length !== 2 || flows[0].category !== "SHOP_BUY" || flows[1].category !== "LOTTO_BUY") throw new Error("flow logs mismatch");
    console.log("cash=899000 inventory=1 lotto=1 flows=2");
  })().finally(() => pool.end()).catch((err) => { console.error(err.message); process.exit(1); });
'

echo '[QA 6/8] 관리자 API 공지 생성·공개 팝업 조회·삭제 확인'
admin_cookie="$(docker exec "$CONTAINER" node -e '
  const config = require("./src/config/config");
  const session = require("./src/web/session");
  const id = config.adminIds[0];
  if (!id) process.exit(2);
  const value = session.signValue(JSON.stringify({ id, username: "QA Admin", avatar: "" }), session.getCookieSecret());
  process.stdout.write("discord_user_test=" + encodeURIComponent(value));
')"
notice_title="QA_POPUP_$(date +%s)"
notice_status="$(request_json POST /api/admin/announcements "{\"title\":\"$notice_title\",\"content\":\"테스트 공지 본문\",\"type\":\"IMPORTANT\",\"is_popup\":true}" "$admin_cookie" "$qa_tmp/notice.json" "$qa_tmp/notice.headers")"
if [[ "$notice_status" != '200' ]]; then
  echo "관리자 공지 HTTP $notice_status: $(tr -d '\r\n' < "$qa_tmp/notice.json")" >&2
  exit 1
fi
qa_notice_id="$(json_value 'data.id' < "$qa_tmp/notice.json")"
curl -fsS "$BASE_URL/api/announcements/popup" -H "Host: $PUBLIC_HOST" -H 'X-Forwarded-Proto: https' > "$qa_tmp/popup.json"
json_value 'data.success === true && data.announcement.id === '"$qa_notice_id"' && data.announcement.title === "'"$notice_title"'"' < "$qa_tmp/popup.json" | grep -q true
delete_status="$(request_json DELETE "/api/admin/announcements/$qa_notice_id" '' "$admin_cookie" "$qa_tmp/delete.json" "$qa_tmp/delete.headers")"
[[ "$delete_status" == '200' ]]
qa_notice_id=""

echo '[QA 7/8] Discord /admin_notice 실행 경로 확인'
docker exec -e QA_NOTICE_TITLE="QA_DISCORD_$(date +%s)" "$CONTAINER" node -e '
  const config = require("./src/config/config");
  const command = require("./src/commands/admin/adminNotice");
  const { pool } = require("./src/config/database");
  (async () => {
    let reply = "";
    const interaction = {
      user: { id: config.adminIds[0], username: "qa-admin", globalName: "QA Admin" },
      options: {
        getSubcommand: () => "create",
        getString: (name) => name === "title" ? process.env.QA_NOTICE_TITLE : (name === "content" ? "Discord command QA" : "GENERAL"),
        getBoolean: () => false,
        getInteger: () => null
      },
      deferReply: async () => {},
      editReply: async (value) => { reply = String(value); return value; }
    };
    await command.execute(interaction);
    if (!reply.startsWith("✅")) throw new Error("command reply failed: " + reply);
    const [rows] = await pool.query("SELECT id FROM site_announcements WHERE title = ? ORDER BY id DESC LIMIT 1", [process.env.QA_NOTICE_TITLE]);
    if (!rows[0]) throw new Error("command did not create notice");
    await pool.query("DELETE FROM site_announcements WHERE id = ?", [rows[0].id]);
    console.log("discord-command=create-ok");
  })().finally(() => pool.end()).catch((err) => { console.error(err.message); process.exit(1); });
'

echo '[QA 8/8] 웹 페이지 스크립트 및 외부 HTTPS 응답 확인'
curl -fsS "$BASE_URL/" -H "Host: $PUBLIC_HOST" -H 'X-Forwarded-Proto: https' | grep -q '/static/js/announcementPopup.js?v='
curl -fsS "$BASE_URL/shop" -H "Host: $PUBLIC_HOST" -H 'X-Forwarded-Proto: https' | grep -q '/socket.io/socket.io.js'
curl -fsS "$BASE_URL/shop" -H "Host: $PUBLIC_HOST" -H 'X-Forwarded-Proto: https' | grep -q '/static/js/announcementPopup.js?v='
curl -fsS "https://$PUBLIC_HOST/readyz" | json_value 'data.ok === true && data.botRequired === false' | grep -q true

echo 'QA_RESULT=PASS login=pass shop=pass lotto=pass admin_notice=pass discord_notice=pass security=pass'
