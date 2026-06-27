// 가락몰 길찾기 핵심 로직 / 생성일: 2026-06-25
// 백엔드 없이 순수 프론트엔드. stores.json / locations.json 을 불러와 동작합니다.

// ── 전역 상태 ──────────────────────────────────────────────
let STORES = [];        // 매장 목록
let LOCATIONS = [];     // QR 위치 목록
let ZONE_BY_KEY = {};   // 구역 대표좌표 맵: "building|floor" → {x,y}
let currentLoc = null;  // 현재 위치(QR) 객체
let destStore = null;   // 현재 안내 중인 목적지 매장
let shownFloor = 1;     // 지도에 표시 중인 층

// 방향 정렬 네비게이션 상태
let USER_HEADING = null;   // 실시간 나침반 방위(0~360) — 없으면 null(QR 고정값 폴백)
let COMPASS_ON = false;    // 나침반 리스너 부착 여부(중복 부착 방지)
let rafPending = false;    // applyHeading rAF 예약 중복 방지
const ARRIVE_R = 40;       // 도착 판정 거리(SVG 단위). 이보다 가까우면 화살표 숨김

// 매장의 지도 좌표를 구한다.
// 1순위: 매장 자체 x,y(정밀)  2순위: 자기 구역(building+층)의 대표좌표  없으면 null
function storeXY(s) {
  if (Number.isFinite(s.x) && Number.isFinite(s.y)) return { x: s.x, y: s.y };
  const z = ZONE_BY_KEY[`${s.building}|${s.floor}`];
  if (z && Number.isFinite(z.x) && Number.isFinite(z.y)) return { x: z.x, y: z.y };
  return null;
}

// 카테고리 버튼 정의: { label(화면표시), terms(검색에 쓸 동의어들) }
// 음성으로 "과일/회/마늘"을 말해도 매칭되도록 terms 에 동의어를 넣습니다.
const CATEGORIES = [
  { label: "청과·과일", terms: ["청과", "과일"] },
  { label: "채소·마늘", terms: ["채소", "마늘"] },
  { label: "수산·생선", terms: ["수산", "생선"] },
  { label: "회센터·회", terms: ["회센터", "회"] },
  { label: "팔도특산품", terms: ["팔도특산품", "특산품", "건어물"] },
];

// ── 초기화 ────────────────────────────────────────────────
async function init() {
  try {
    // 데이터 파일 로드 (※ file:// 직접 열기 시 fetch 차단됨 → README의 로컬 서버 사용 안내)
    // cache:"no-store" — 폰 브라우저가 옛 데이터를 캐시하지 않도록 항상 최신을 받음
    const noStore = { cache: "no-store" };
    const [storesRes, locsRes, zonesRes] = await Promise.all([
      fetch("stores.json", noStore),
      fetch("locations.json", noStore),
      fetch("zones.json", noStore).catch(() => null),   // zones.json 은 선택(없어도 동작)
    ]);
    STORES = (await storesRes.json()).stores;
    LOCATIONS = (await locsRes.json()).locations;
    // 구역 대표좌표 맵 구성
    if (zonesRes && zonesRes.ok) {
      const zones = (await zonesRes.json()).zones || [];
      zones.forEach((z) => { ZONE_BY_KEY[z.key] = z; });
    }
  } catch (e) {
    showFatal("데이터를 불러오지 못했습니다. README의 '실행 방법'대로 로컬 서버로 열어주세요.");
    return;
  }

  resolveCurrentLocation();   // URL ?loc= 로 현재 위치 결정
  renderCategoryButtons();    // 카테고리 버튼 생성
  setupVoice();               // 음성 인식 준비
  // 지도/층탭은 입력(음성·버튼) 후에 그린다 (초기 화면은 입력 UI만)
}

// URL 파라미터(?loc=gate2)로 현재 위치를 찾습니다. 없으면 첫 위치로 폴백.
function resolveCurrentLocation() {
  const params = new URLSearchParams(location.search);
  const locId = params.get("loc");
  currentLoc = LOCATIONS.find((l) => l.locId === locId) || LOCATIONS[0];
  shownFloor = currentLoc.floor;
  // 현재위치 표시 요소가 있으면 갱신(헤더를 제거한 레이아웃에서는 없을 수 있음)
  const locNameEl = document.getElementById("currentLocName");
  if (locNameEl) {
    locNameEl.textContent = `${currentLoc.building} ${currentLoc.floor}층 · ${currentLoc.name}`;
  }
}

// ── 입력: 카테고리 버튼 ────────────────────────────────────
function renderCategoryButtons() {
  const box = document.getElementById("categoryButtons");
  box.innerHTML = "";
  CATEGORIES.forEach((c) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = c.label;
    btn.addEventListener("click", () => { enableCompass(); handleQuery(c.terms[0]); });
    box.appendChild(btn);
  });
}

// ── 매칭 로직 ──────────────────────────────────────────────
// 입력어 → 취급 매장 필터 → 현재 위치에서 가장 가까운 매장 선정
function handleQuery(query) {
  const q = String(query).trim();
  if (!q) return;

  // 1) 입력어를 취급하는 매장 필터
  //    매장 categories 중 하나라도 입력어를 포함하거나, 입력어가 그것을 포함하면 매칭
  const matches = STORES.filter((s) =>
    s.categories.some((cat) => cat.includes(q) || q.includes(cat))
  );

  if (matches.length === 0) {
    showResultMessage(`'${q}' 를 파는 매장을 찾지 못했어요. 다른 품목을 눌러보세요.`);
    return;
  }

  // 2) 지도 좌표(매장 정밀좌표 또는 구역 대표좌표)가 있는 매장만 길안내 후보로
  const located = matches
    .map((s) => ({ s, xy: storeXY(s) }))
    .filter((o) => o.xy);
  if (located.length === 0) {
    showResultMessage(
      `'${q}' 취급 매장을 ${matches.length}곳 찾았지만, 아직 지도 좌표가 입력되지 않았어요. ` +
      `운영자 좌표 매핑 도구(admin-map.html)로 구역 위치를 지정하면 길안내가 표시됩니다.`
    );
    return;
  }

  // 3) 현재 위치에서 직선거리가 가장 가까운 매장 선정 (프로토타입: 단순 직선거리)
  destStore = located.reduce((a, b) =>
    dist(currentLoc, a.xy) < dist(currentLoc, b.xy) ? a : b
  ).s;

  showResultCard(q, destStore);
  // 입력이 성공하면 네비게이션(지도) 화면을 표시
  document.querySelector(".map-section").classList.remove("hidden");
  shownFloor = destStore.floor;   // 목적지 층을 지도에 표시
  renderFloorTabs();
  renderMap();
}

// 두 좌표 사이 직선거리(유클리드). 같은 층 가정의 단순 계산.
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ── 방위 계산 ──────────────────────────────────────────────
// from→to 의 화면 방위각(0~360). 화면 '위'=북=0, 시계방향(동90·남180·서270).
// SVG 는 y가 아래로 증가하므로 -dy 로 '위'를 북쪽에 맞춘다.
function bearingTo(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

// 현재 사용할 방위: 라이브 나침반 우선 → QR 고정값 → 없으면 북(0).
function activeHeading() {
  if (USER_HEADING != null) return USER_HEADING;
  return currentLoc.heading ?? 0;
}

// 각도 저주파 필터(떨림 완화). 최단호로 보간한다.
function lowpassAngle(prev, next, a) {
  const diff = ((next - prev + 540) % 360) - 180;
  return (prev + a * diff + 360) % 360;
}

// ── 나침반(DeviceOrientation) ──────────────────────────────
// 폰 방향 변화를 받아 지도/화살표를 실시간 회전. 미지원·미허용·HTTP면 조용히
// 폴백(QR 고정값). 권한은 반드시 사용자 제스처(버튼 탭) 안에서 요청해야 한다(iOS).
function enableCompass() {
  if (COMPASS_ON) return;
  if (!window.isSecureContext) return;            // http → QR 고정 폴백
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) return;

  const attach = () => {
    if (COMPASS_ON) return;
    COMPASS_ON = true;
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
    window.addEventListener("deviceorientation", onOrientation, true);
  };

  if (typeof DOE.requestPermission === "function") {
    // iOS Safari: 제스처 동기 경로에서 권한 팝업
    DOE.requestPermission().then((res) => { if (res === "granted") attach(); }).catch(() => {});
  } else {
    attach();   // Android/기타
  }
}

// 방향 이벤트 → heading 산출 → 필터 → rAF로 applyHeading 1회 예약.
function onOrientation(e) {
  // absolute 이벤트를 받기 시작하면 일반 deviceorientation 리스너를 떼어
  // 둘 다 발생하는 기기에서 onOrientation 이 한 틱에 두 번 도는 것을 막는다.
  if (e.type === "deviceorientationabsolute") {
    window.removeEventListener("deviceorientation", onOrientation, true);
  }
  let h;
  if (typeof e.webkitCompassHeading === "number") {
    h = e.webkitCompassHeading;            // iOS: 북=0 시계방향
  } else if (e.absolute && typeof e.alpha === "number") {
    h = (360 - e.alpha) % 360;             // Android: alpha 보정
  } else {
    return;                                // 보정 불가 → 폴백 유지
  }
  USER_HEADING = USER_HEADING == null ? h : lowpassAngle(USER_HEADING, h, 0.15);
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; applyHeading(); });
  }
}

// ── 결과 카드 ──────────────────────────────────────────────
function showResultCard(query, store) {
  const card = document.getElementById("resultCard");
  const sameFloor = store.floor === currentLoc.floor;
  const xy = storeXY(store);
  const arrived = sameFloor && xy && dist(currentLoc, xy) < ARRIVE_R;

  const floorNote = !sameFloor
    ? `현재 ${currentLoc.floor}층 → 목적지 ${store.floor}층. 에스컬레이터로 ${store.floor}층 이동 후 안내를 따르세요.`
    : arrived
    ? `이 구역에 도착했어요. 같은 구역의 매대를 둘러보세요.`
    : `같은 ${store.floor}층입니다. 화면의 화살표 방향으로 가세요.`;

  card.innerHTML = `
    <h2>📍 ${store.name}</h2>
    <p class="store-meta"><span class="label">관/판매동</span> ${store.building}</p>
    <p class="store-meta"><span class="label">구역</span> ${store.zone} · ${store.floor}층</p>
    <div class="tags">${store.categories.map((c) => `<span class="tag">${c}</span>`).join("")}</div>
    <p class="floor-note">🧭 ${floorNote}</p>
    <p class="zone-note">방향 안내는 구역 단위입니다(매장 정밀위치는 추후 반영).</p>
  `;
  card.classList.remove("hidden");
}

function showResultMessage(msg) {
  const card = document.getElementById("resultCard");
  card.innerHTML = `<p class="store-meta">${msg}</p>`;
  card.classList.remove("hidden");
  destStore = null;
  renderMap();
}

// ── 층 탭 ─────────────────────────────────────────────────
function renderFloorTabs() {
  const floors = [...new Set([
    ...LOCATIONS.map((l) => l.floor),
    ...STORES.map((s) => s.floor),
  ])].sort((a, b) => a - b);

  const tabs = document.getElementById("floorTabs");
  tabs.innerHTML = "";
  floors.forEach((f) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `${f}층`;
    btn.className = f === shownFloor ? "active" : "";
    btn.addEventListener("click", () => { shownFloor = f; renderFloorTabs(); renderMap(); });
    tabs.appendChild(btn);
  });
}

// ── 지도(SVG) 그리기 ───────────────────────────────────────
// 자체 SVG 평면도 + 현재 위치/목적지 마커 + 경로선.
// 배경·경로·마커는 회전 그룹(#mapRotate)에 넣어 사용자 방향만큼 통째로 돌리고,
// 진행 화살표(#dirArrow)는 회전 그룹 바깥에서 목적지 상대방향을 가리킨다.
// ※ 전체 재렌더는 층 전환·새 목적지 때만. 나침반 갱신은 applyHeading()이 transform만 바꿈.
function renderMap() {
  const svg = document.getElementById("mapSvg");

  const onFloorCurrent = currentLoc.floor === shownFloor;
  const onFloorDest = destStore && destStore.floor === shownFloor;
  const destXY = destStore ? storeXY(destStore) : null;

  // 회전 그룹 내부: 배경 + 경로 + 마커
  let inner = drawFloorPlanBackground(shownFloor);
  if (onFloorCurrent && onFloorDest && destXY) {
    inner += routePath(currentLoc, destXY);
  }
  if (onFloorCurrent) inner += marker(currentLoc.x, currentLoc.y, "#1e7a3c", "현재위치", "●");
  if (onFloorDest && destXY) inner += marker(destXY.x, destXY.y, "#e8731a", destStore.name, "★");

  // 화살표 중심 = 현재위치(없으면 화면 중앙). 회전 그룹 바깥에 둔다.
  const cx = onFloorCurrent ? currentLoc.x : 500;
  const cy = onFloorCurrent ? currentLoc.y : 500;

  svg.innerHTML =
    `<g id="mapRotate">${inner}</g>` + directionArrow(cx, cy);

  applyHeading();   // 현재 방위로 회전·화살표 적용
}

// 진행 화살표(위=북 기본). applyHeading()이 rotate(rel, cx, cy)로 목적지 방향 지시.
function directionArrow(cx, cy) {
  const tip = cy - 160;        // 화살촉 끝
  const base = cy - 50;        // 막대 시작(현재위치 마커 위)
  return `<g id="dirArrow" style="display:none">
    <line x1="${cx}" y1="${base}" x2="${cx}" y2="${tip + 36}" stroke="#fff" stroke-width="30" stroke-linecap="round"/>
    <line x1="${cx}" y1="${base}" x2="${cx}" y2="${tip + 36}" stroke="#e8731a" stroke-width="20" stroke-linecap="round"/>
    <polygon points="${cx},${tip} ${cx - 40},${tip + 52} ${cx + 40},${tip + 52}" fill="#e8731a" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
  </g>`;
}

// 재렌더 없이 transform 만 갱신: 지도 회전 + 화살표 방향 + 라벨 정립.
function applyHeading() {
  const H = activeHeading();
  const g = document.getElementById("mapRotate");
  if (!g) return;

  const onFloor = currentLoc.floor === shownFloor;
  const cx = onFloor ? currentLoc.x : 500;
  const cy = onFloor ? currentLoc.y : 500;

  // 지도 회전: 사용자가 향한 방향(H)을 화면 위(0)로. 현재 층 아닐 땐 회전 안 함.
  g.setAttribute("transform", onFloor ? `rotate(${-H} ${cx} ${cy})` : "");

  // 진행 화살표: 같은 층 + 목적지 존재 + 도착 임계 밖일 때만 표시
  const arrow = document.getElementById("dirArrow");
  if (arrow) {
    const destXY = destStore ? storeXY(destStore) : null;
    const show =
      onFloor && destXY && destStore.floor === shownFloor &&
      dist(currentLoc, destXY) >= ARRIVE_R;
    arrow.style.display = show ? "" : "none";
    if (show) {
      const rel = (bearingTo(currentLoc, destXY) - H + 360) % 360;
      arrow.setAttribute("transform", `rotate(${rel} ${cx} ${cy})`);
    }
  }

  // 라벨 정립: 지도가 rotate(-H)일 때만 각 라벨을 rotate(+H)로 역회전.
  // 다른 층이면 지도가 회전하지 않으므로 라벨도 회전하지 않는다(삐뚤어짐 방지).
  g.querySelectorAll(".lbl").forEach((el) => {
    el.setAttribute("transform", onFloor ? `rotate(${H} ${el.dataset.x} ${el.dataset.y})` : "");
  });
}

// 단순 평면도 배경: 외벽 + 통로(중앙 십자) + 구역 블록 격자
function drawFloorPlanBackground(floor) {
  let s = "";
  // 외벽
  s += `<rect x="20" y="20" width="960" height="960" rx="20" fill="#ffffff" stroke="#c7d0c7" stroke-width="6"/>`;
  // 구역 블록(매대 묶음) — 시각적 배경용 격자
  const blocks = [
    [70, 90, 360, 250], [560, 90, 360, 250],
    [70, 430, 360, 220], [560, 430, 360, 220],
    [70, 720, 360, 200], [560, 720, 360, 200],
  ];
  blocks.forEach(([x, y, w, h]) => {
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#eef3ee" stroke="#dce4dc" stroke-width="3"/>`;
  });
  // 중앙 통로(십자) — 점선
  s += `<line x1="500" y1="40" x2="500" y2="960" stroke="#cdd6cd" stroke-width="14" stroke-dasharray="2 18" stroke-linecap="round"/>`;
  s += `<line x1="40" y1="400" x2="960" y2="400" stroke="#cdd6cd" stroke-width="14" stroke-dasharray="2 18" stroke-linecap="round"/>`;
  // 층 표시
  s += `<text x="40" y="60" font-size="34" fill="#9aa89a" font-weight="700">${floor}층</text>`;
  return s;
}

// 경로선: 맨해튼(ㄱ자) 꺾인 선으로 통로 느낌을 줌
function routePath(from, to) {
  const midX = to.x; // 세로 먼저 이동 후 가로(단순 꺾임)
  const d = `M ${from.x} ${from.y} L ${from.x} ${to.y} L ${to.x} ${to.y}`;
  return `<path d="${d}" fill="none" stroke="#e8731a" stroke-width="10"
            stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="22 16">
            <animate attributeName="stroke-dashoffset" from="38" to="0" dur="0.8s" repeatCount="indefinite"/>
          </path>`;
}

// 마커: 원 + 아이콘 + 라벨
// 라벨(rect+text)은 .lbl 그룹으로 감싸 지도 회전 시 마커 중심 기준으로 역회전(글자 정립).
function marker(x, y, color, label, glyph) {
  return `
    <g>
      <circle cx="${x}" cy="${y}" r="26" fill="${color}" stroke="#fff" stroke-width="5"/>
      <text x="${x}" y="${y + 9}" font-size="26" fill="#fff" text-anchor="middle" font-weight="700">${glyph}</text>
      <g class="lbl" data-x="${x}" data-y="${y}">
        <rect x="${x - 90}" y="${y + 34}" width="180" height="44" rx="10" fill="${color}" opacity="0.95"/>
        <text x="${x}" y="${y + 63}" font-size="24" fill="#fff" text-anchor="middle" font-weight="700">${label}</text>
      </g>
    </g>`;
}

// ── 음성 인식 (Web Speech API) ─────────────────────────────
function setupVoice() {
  const btn = document.getElementById("voiceBtn");
  const statusEl = document.getElementById("voiceStatus");

  const micLabel = document.querySelector(".mic-label");

  // 보안 컨텍스트 확인: 음성인식은 HTTPS(또는 localhost)에서만 동작.
  // HTTP로 폰에서 열면 사파리가 SpeechRecognition 을 막아 여기서 걸린다.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const secure = window.isSecureContext;   // https/localhost = true
  if (!SR || !secure) {
    // ⚠️ 마이크 아이콘(SVG)은 그대로 두고, 라벨/안내만 바꾼다 (아이콘 사라지지 않게)
    if (micLabel) micLabel.textContent = secure
      ? "이 브라우저는 음성을 지원하지 않아요 — 아래 버튼 이용"
      : "음성은 보안연결(https)에서만 돼요 — 아래 버튼 이용";
    statusEl.textContent = "지금은 음성이 안 돼요. 아래 카테고리 버튼으로 찾아보세요.";
    // 눌러도 같은 안내만 (앱이 멈춘 것처럼 보이지 않게)
    btn.addEventListener("click", () => {
      statusEl.textContent = "이 환경에선 음성이 안 돼요. 아래 카테고리 버튼을 눌러주세요.";
    });
    return;
  }

  const recog = new SR();
  recog.lang = "ko-KR";          // 한국어 인식
  recog.interimResults = false;
  recog.maxAlternatives = 3;

  let listening = false;   // 현재 듣는 중인지
  let canceled = false;    // 사용자가 다시 눌러 취소했는지

  btn.addEventListener("click", () => {
    enableCompass();   // 사용자 제스처 안에서 나침반 권한 확보(iOS)
    if (listening) {
      // 듣는 중 다시 누르면 취소
      canceled = true;
      recog.abort();
      return;
    }
    try {
      statusEl.textContent = "듣고 있어요… (다시 누르면 취소)";
      btn.classList.add("listening");
      recog.start();
      listening = true;
      canceled = false;
    } catch (_) { /* 연속 클릭 시 start 중복 예외 무시 */ }
  });

  recog.addEventListener("result", (ev) => {
    const said = ev.results[0][0].transcript.trim();
    statusEl.textContent = `"${said}" 로 들었어요`;
    handleQuery(said);
  });
  recog.addEventListener("error", (ev) => {
    if (ev.error === "aborted") return;   // 취소는 오류 메시지 표시 안 함
    statusEl.textContent = ev.error === "no-speech"
      ? "소리를 못 들었어요. 다시 시도하거나 아래 버튼을 눌러주세요."
      : "음성 인식 오류. 아래 카테고리 버튼을 이용해주세요.";
  });
  recog.addEventListener("end", () => {
    listening = false;
    btn.classList.remove("listening");
    if (canceled) { statusEl.textContent = ""; canceled = false; }   // 취소 시 메시지 비움
  });
}

// ── 치명적 오류 표시 ───────────────────────────────────────
function showFatal(msg) {
  document.querySelector("main").innerHTML =
    `<p style="padding:24px;font-size:1.2rem;color:#b00;">${msg}</p>`;
}

// 시작
init();
