#!/bin/bash
# 가락몰 길찾기 — 원클릭 실행 스크립트 / 생성일: 2026-06-25
# Finder에서 이 파일을 더블클릭하면 서버가 켜지고 브라우저가 자동으로 열립니다.
# (터미널에서 직접: ./start.command  또는  bash start.command)

# 이 스크립트가 있는 폴더로 이동
cd "$(dirname "$0")" || exit 1

PORT=8421   # 가락몰 전용 포트 (8000은 다른 프로그램과 충돌하므로 변경)

# 같은 포트를 이미 쓰는 서버가 있으면 종료 (중복 실행 시 'Address already in use' 방지)
EXIST=$(lsof -ti "tcp:$PORT" 2>/dev/null)
if [ -n "$EXIST" ]; then
  echo "ℹ️  이미 켜져 있던 서버를 정리합니다…"
  echo "$EXIST" | xargs kill -9 2>/dev/null
  sleep 1
fi

# 현재 PC의 와이파이/랜 IP 자동 감지 (폰에서 접속할 주소)
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
[ -z "$IP" ] && IP="127.0.0.1"   # 못 찾으면 로컬만

echo ""
echo "🛒  가락몰 길찾기 서버를 시작합니다"
echo "────────────────────────────────────────────"
echo "  📱 폰으로 접속 (같은 와이파이):  http://$IP:$PORT/?loc=g-b1-west"
echo "  🏷️  QR 생성/인쇄 (PC 화면):       http://$IP:$PORT/admin-qr.html"
echo "  📍 좌표 매핑 도구:                http://$IP:$PORT/admin-map.html"
echo "────────────────────────────────────────────"
echo "  종료하려면 이 창에서  Ctrl + C  를 누르세요."
echo ""

# 서버가 뜬 직후(1.5초 뒤) 브라우저로 QR 페이지 자동 열기
# (IP 주소로 열어야 QR이 현재 IP 기준으로 자동 생성됩니다)
( sleep 1.5; open "http://$IP:$PORT/admin-qr.html" ) &

# 로컬 웹서버 실행 (0.0.0.0 바인딩 → 같은 와이파이의 폰에서도 접속 가능)
python3 -m http.server "$PORT"
