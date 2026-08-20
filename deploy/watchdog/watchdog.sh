#!/usr/bin/env bash
# 월덕 감시자: Docker가 꺼지거나 앱이 응답하지 않으면 다시 기동한다.
# 유지보수 일시정지: /home/wtrdd/discord-bot/logs/watchdog/off 파일을 만들면 멈춘다.
set -u

COMPOSE_FILE="/home/wtrdd/discord-bot/docker-compose.yml"
PROJECT_DIR="/home/wtrdd/discord-bot"
STATE_DIR="/home/wtrdd/discord-bot/logs/watchdog"
LOG_FILE="/home/wtrdd/discord-bot/logs/watchdog.jsonl"
HEALTH_URL="http://127.0.0.1:8080/healthz"
STATUS_URL="http://127.0.0.1:8090/healthz"
COOLDOWN_SEC=90
FAIL_NEED=2
MAX_RESTARTS=5
WINDOW_SEC=600

mkdir -p "$STATE_DIR"
touch "$LOG_FILE"
chmod 755 "$STATE_DIR" 2>/dev/null || true
chmod 644 "$LOG_FILE" 2>/dev/null || true

json_escape() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
}

log_event() {
  local action="$1"
  local reason="$2"
  local ok="$3"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"ts":"%s","action":"%s","reason":"%s","ok":%s}\n' \
    "$ts" "$(json_escape "$action")" "$(json_escape "$reason")" "$ok" >> "$LOG_FILE"
  # 로그가 너무 커지지 않게 최근 400줄만 유지
  if [[ "$(wc -l < "$LOG_FILE")" -gt 500 ]]; then
    tail -n 400 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
  fi
}

if [[ -f "$STATE_DIR/off" ]]; then
  exit 0
fi

now_epoch="$(date +%s)"

restart_budget_ok() {
  local file="$STATE_DIR/restarts"
  touch "$file"
  local cutoff=$((now_epoch - WINDOW_SEC))
  local kept=""
  local count=0
  while read -r ts; do
    [[ -z "$ts" ]] && continue
    if [[ "$ts" -ge "$cutoff" ]]; then
      kept+="$ts"$'\n'
      count=$((count + 1))
    fi
  done < "$file"
  printf '%s' "$kept" > "$file"
  if [[ "$count" -ge "$MAX_RESTARTS" ]]; then
    return 1
  fi
  return 0
}

mark_restart() {
  echo "$now_epoch" >> "$STATE_DIR/restarts"
}

in_cooldown() {
  local last=0
  if [[ -f "$STATE_DIR/last_restart" ]]; then
    last="$(cat "$STATE_DIR/last_restart" 2>/dev/null || echo 0)"
  fi
  if [[ $((now_epoch - last)) -lt $COOLDOWN_SEC ]]; then
    return 0
  fi
  return 1
}

stamp_restart() {
  echo "$now_epoch" > "$STATE_DIR/last_restart"
  mark_restart
}

compose() {
  docker compose -f "$COMPOSE_FILE" --project-directory "$PROJECT_DIR" "$@"
}

container_running() {
  local name="$1"
  local state
  state="$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)"
  [[ "$state" == "true" ]]
}

ensure_docker() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi
  systemctl start docker >/dev/null 2>&1 || true
  sleep 2
  if docker info >/dev/null 2>&1; then
    log_event "start_docker" "docker_daemon_down" true
    return 0
  fi
  log_event "start_docker" "docker_daemon_down" false
  return 1
}

ensure_status() {
  if curl -fsS --max-time 3 "$STATUS_URL" >/dev/null 2>&1; then
    return 0
  fi
  systemctl start wtrdd-status.service >/dev/null 2>&1 || true
}

ensure_container() {
  local name="$1"
  local reason="$2"
  if container_running "$name"; then
    return 0
  fi
  if in_cooldown; then
    return 0
  fi
  if ! restart_budget_ok; then
    log_event "restart_skipped" "restart_loop_guard:$name" false
    return 1
  fi
  stamp_restart
  if [[ "$name" == "wtrdd-discord-app" ]]; then
    compose --profile app up -d app >/dev/null 2>&1
  else
    compose up -d proxy tunnel autoheal >/dev/null 2>&1
  fi
  local ok=false
  if container_running "$name"; then
    ok=true
  fi
  log_event "compose_up" "$reason" "$ok"
}

http_ok() {
  curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1
}

ensure_docker || exit 0
ensure_status

ensure_container "wtrdd-discord-app" "app_container_not_running"
ensure_container "wtrdd-edge-proxy" "proxy_container_not_running"
ensure_container "wtrdd-cloudflared" "tunnel_container_not_running"
ensure_container "wtrdd-autoheal" "autoheal_container_not_running"

FAIL_FILE="$STATE_DIR/fail_count"
fail=0
if [[ -f "$FAIL_FILE" ]]; then
  fail="$(cat "$FAIL_FILE" 2>/dev/null || echo 0)"
fi
if ! [[ "$fail" =~ ^[0-9]+$ ]]; then
  fail=0
fi

if http_ok; then
  echo 0 > "$FAIL_FILE"
  exit 0
fi

fail=$((fail + 1))
echo "$fail" > "$FAIL_FILE"
log_event "health_fail" "healthz_failed:$fail" false

if [[ "$fail" -lt "$FAIL_NEED" ]]; then
  exit 0
fi

if in_cooldown; then
  exit 0
fi
if ! restart_budget_ok; then
  log_event "restart_skipped" "restart_loop_guard:healthz" false
  exit 0
fi

stamp_restart
if container_running "wtrdd-discord-app"; then
  docker restart wtrdd-discord-app >/dev/null 2>&1
  log_event "restart_app" "healthz_failed" true
else
  compose --profile app up -d app >/dev/null 2>&1
  log_event "compose_up" "healthz_failed_missing" true
fi

echo 0 > "$FAIL_FILE"
exit 0
