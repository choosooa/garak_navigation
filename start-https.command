#!/bin/bash
# 가락몰 길찾기 — HTTPS 실행 (폰에서 음성인식·나침반을 쓰려면 이걸로 실행)
# 음성인식(Web Speech)·마이크·나침반은 보안연결(https)에서만 동작하기 때문에,
# 폰으로 시연할 때는 start.command 대신 이 파일을 더블클릭하세요.
cd "$(dirname "$0")"

PORT=8443

# 1) 자체 서명 인증서 준비 (최초 1회 자동 생성)
if [ ! -f .cert/cert.pem ]; then
  echo "🔐 인증서 생성 중 (최초 1회)..."
  mkdir -p .cert
  openssl req -x509 -newkey rsa:2048 -keyout .cert/key.pem -out .cert/cert.pem \
    -days 825 -nodes -subj "/CN=garakmall.local" 2>/dev/null
fi

# 2) 와이파이 IP 안내
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "IP확인실패")
echo ""
echo "════════════════════════════════════════════════"
echo "  📱 폰에서 접속:  https://$IP:$PORT/"
echo "  💻 이 컴퓨터:    https://localhost:$PORT/"
echo "────────────────────────────────────────────────"
echo "  ⚠️ 폰에서 처음 열면 '연결이 비공개가 아닙니다'"
echo "     경고가 떠요 (자체 인증서라 정상)."
echo "     [세부사항 보기] → [웹사이트 방문]을 누르면"
echo "     이후 음성인식·나침반이 정상 동작합니다."
echo "  종료: 이 창에서 Ctrl + C"
echo "════════════════════════════════════════════════"
echo ""

# 3) HTTPS 서버 실행
python3 - << 'EOF'
import http.server, ssl
server = http.server.ThreadingHTTPServer(("0.0.0.0", 8443), http.server.SimpleHTTPRequestHandler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(".cert/cert.pem", ".cert/key.pem")
server.socket = ctx.wrap_socket(server.socket, server_side=True)
server.serve_forever()
EOF
