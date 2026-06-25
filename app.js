// 가락몰 길찾기 핵심 로직 / 생성일: 2026-06-25
// 백엔드 없이 순수 프론트엔드. stores.json / locations.json 을 불러와 동작합니다.

// ── 전역 상태 ──────────────────────────────────────────────
let STORES = [];        // 매장 목록
let LOCATIONS = [];     // QR 위치 목록
let ZONE_BY_KEY = {};   // 구역 대표좌표 맵: "building|floor" → {x,y}
let currentLoc = null;  // 현재 위치(QR) 객체
let destStore = null;   // 현재 안내 중인 목적지 매장
let shownFloor = 1;     // 지도에 표시 중인 층

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
    btn.addEventListener("click", () => handleQuery(c.terms[0]));
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

// ── 결과 카드 ──────────────────────────────────────────────
function showResultCard(query, store) {
  const card = document.getElementById("resultCard");
  const sameFloor = store.floor === currentLoc.floor;
  const floorNote = sameFloor
    ? `같은 ${store.floor}층입니다. 지도의 선을 따라가세요.`
    : `현재 ${currentLoc.floor}층 → 목적지 ${store.floor}층. 에스컬레이터로 ${store.floor}층 이동 후 안내를 따르세요.`;

  card.innerHTML = `
    <h2>📍 ${store.name}</h2>
    <p class="store-meta"><span class="label">관/판매동</span> ${store.building}</p>
    <p class="store-meta"><span class="label">구역</span> ${store.zone} · ${store.floor}층</p>
    <div class="tags">${store.categories.map((c) => `<span class="tag">${c}</span>`).join("")}</div>
    <p class="floor-note">🧭 ${floorNote}</p>
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
// 자체 SVG 평면도 + 현재 위치/목적지 마커 + 경로선
function renderMap() {
  const svg = document.getElementById("mapSvg");
  // 1) 배경 평면도 (단순한 통로/구역 표현)
  let svgParts = drawFloorPlanBackground(shownFloor);

  // 2) 현재 위치 마커 (해당 층일 때만)
  const onFloorCurrent = currentLoc.floor === shownFloor;
  // 3) 목적지 마커 (해당 층일 때만)
  const onFloorDest = destStore && destStore.floor === shownFloor;

  // 목적지 좌표(매장 정밀 or 구역 대표)
  const destXY = destStore ? storeXY(destStore) : null;

  // 4) 경로선: 현재 위치와 목적지가 같은 층에 함께 보일 때만 직접 연결
  if (onFloorCurrent && onFloorDest && destXY) {
    svgParts += routePath(currentLoc, destXY);
  }

  // 마커는 선 위에 오도록 마지막에 그림
  if (onFloorCurrent) svgParts += marker(currentLoc.x, currentLoc.y, "#1e7a3c", "현재위치", "●");
  if (onFloorDest && destXY) svgParts += marker(destXY.x, destXY.y, "#e8731a", destStore.name, "★");

  svg.innerHTML = svgParts;
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
function marker(x, y, color, label, glyph) {
  // 라벨이 지도 밖으로 나가지 않게 좌우 정렬 간단 보정
  const anchor = x > 820 ? "end" : x < 180 ? "start" : "middle";
  return `
    <g>
      <circle cx="${x}" cy="${y}" r="26" fill="${color}" stroke="#fff" stroke-width="5"/>
      <text x="${x}" y="${y + 9}" font-size="26" fill="#fff" text-anchor="middle" font-weight="700">${glyph}</text>
      <rect x="${x - 90}" y="${y + 34}" width="180" height="44" rx="10" fill="${color}" opacity="0.95"/>
      <text x="${x}" y="${y + 63}" font-size="24" fill="#fff" text-anchor="middle" font-weight="700">${label}</text>
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
