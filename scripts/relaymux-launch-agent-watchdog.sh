#!/bin/sh
set -u

PATH="${PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
MAIN_LABEL="${RELAYMUX_MAIN_LABEL:-com.relaymux.daemon}"
DOMAIN="${RELAYMUX_LAUNCH_DOMAIN:-gui/$(/usr/bin/id -u)}"
TARGET="${DOMAIN}/${MAIN_LABEL}"
PLIST="${RELAYMUX_MAIN_PLIST:-${HOME}/Library/LaunchAgents/${MAIN_LABEL}.plist}"
HEALTH_URL="${RELAYMUX_HEALTH_URL:-http://127.0.0.1:47761/health}"
LOG="${RELAYMUX_WATCHDOG_LOG:-${HOME}/.relaymux/logs/launch-agent-watchdog.log}"

mkdir -p "$(/usr/bin/dirname "$LOG")"

stamp() {
  /bin/date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log() {
  printf '[%s] %s\n' "$(stamp)" "$*" >> "$LOG"
}

is_launchd_running() {
  /bin/launchctl print "$TARGET" 2>/dev/null | /usr/bin/grep -q 'state = running'
}

is_webhook_healthy() {
  /usr/bin/curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

if is_launchd_running && is_webhook_healthy; then
  exit 0
fi

if ! /bin/test -f "$PLIST"; then
  log "missing plist: $PLIST"
  exit 1
fi

log "relaymux unhealthy or unloaded; restarting ${TARGET}"
/bin/launchctl bootout "$TARGET" >> "$LOG" 2>&1 || true
/bin/sleep 1
/bin/launchctl enable "$TARGET" >> "$LOG" 2>&1 || true

attempt=1
while [ "$attempt" -le 3 ]; do
  if /bin/launchctl print "$TARGET" >/dev/null 2>&1; then
    /bin/launchctl kickstart -k "$TARGET" >> "$LOG" 2>&1 || true
  else
    /bin/launchctl bootstrap "$DOMAIN" "$PLIST" >> "$LOG" 2>&1 || true
    /bin/launchctl kickstart -k "$TARGET" >> "$LOG" 2>&1 || true
  fi

  /bin/sleep 3
  if is_launchd_running && is_webhook_healthy; then
    log "relaymux healthy after restart attempt ${attempt}"
    exit 0
  fi

  log "restart attempt ${attempt} did not become healthy; retrying"
  /bin/launchctl bootout "$TARGET" >> "$LOG" 2>&1 || true
  /bin/sleep 1
  attempt=$((attempt + 1))
done

log "failed to restore relaymux after 3 attempts"
exit 1
