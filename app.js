// 가락몰 길찾기 핵심 로직 / 생성일: 2026-06-25
// 백엔드 없이 순수 프론트엔드. stores.json / locations.json / zones.json / floorplans/index.json 을 불러와 동작합니다.
// 지도는 공식 층별 평면도 PNG(floorplans/)를 SVG 배경으로 깔고, 좌표는 해당 평면도의 픽셀좌표를 씁니다.
// 평면도가 없는 층은 약식 격자 안내도(0~1000 좌표계)로 폴백합니다.

// ── 전역 상태 ──────────────────────────────────────────────
let STORES = [];        // 매장 목록
let LOCATIONS = [];     // QR 위치 목록
let ZONE_BY_KEY = {};   // 구역 대표좌표 맵: "building|floor" → {x,y}
let PLANS = [];         // 평면도 인덱스 (floorplans/index.json)
let PLAN_BY_KEY = {};   // "동코드|층코드" → plan 항목 (예: "G|B1")
let currentLoc = null;  // 현재 위치(QR) 객체
let destStore = null;   // 현재 안내 중인 목적지 매장
let shownDong = null;   // 지도에 표시 중인 동코드(A~G)
let shownFloor = 1;     // 지도에 표시 중인 층

// 방향 정렬 상태 — 지도는 북쪽 고정, 헤딩 콘/HUD 화살표만 회전
let USER_HEADING = null;   // 실시간 나침반 방위(0~360) — 없으면 null(QR 고정값 폴백)
let COMPASS_ON = false;    // 나침반 리스너 부착 여부(중복 부착 방지)
let rafPending = false;    // applyHeading rAF 예약 중복 방지

const DEBUG = new URLSearchParams(location.search).get("debug") === "1";

// ── 건물명 → 평면도 매핑 (admin-map.html 과 동일 규칙) ─────
function dongOf(b) {
  if (!b) return null;
  if (b.includes("5관")) return "A";
  if (b.includes("4관")) return "B";
  if (b.includes("1관")) return "E";
  if (b.includes("업무동")) return "F";
  if (b.includes("판매동")) return "G";
  if (b.includes("2관")) return "C";   // 2관은 C/D 두 구역 → 기본 C
  if (b.includes("3관")) return "D";
  return null;
}
function floorCode(f) { return f < 0 ? "B" + (-f) : f + "F"; }
function floorLabel(f) { return f < 0 ? `지하${-f}층` : `${f}층`; }
function planFor(dong, floor) { return PLAN_BY_KEY[`${dong}|${floorCode(floor)}`] || null; }

// 도착 판정 거리: 평면도 층은 픽셀좌표라 층 크기에 비례시킨다
function arriveR(plan) { return plan ? Math.min(plan.w, plan.h) * 0.11 : 40; }

// 매장의 지도 좌표를 구한다.
// 1순위: 매장 자체 x,y(정밀)  2순위: 자기 구역(building+층)의 대표좌표  없으면 null
function storeXY(s) {
  if (Number.isFinite(s.x) && Number.isFinite(s.y)) return { x: s.x, y: s.y };
  const z = ZONE_BY_KEY[`${s.building}|${s.floor}`];
  if (z && Number.isFinite(z.x) && Number.isFinite(z.y)) return { x: z.x, y: z.y };
  return null;
}

// 매장 좌표가 공식 평면도에 정합된(믿을 수 있는) 좌표인지.
// 매장 자체 정밀좌표 또는 mapped:true 구역의 대표좌표만 정합으로 본다.
// (그 외 구역 좌표는 임의 배치값이라 평면도 위 위치·거리 비교에 쓰면 안 됨)
function storeMapped(s) {
  if (Number.isFinite(s.x) && Number.isFinite(s.y)) return true;
  const z = ZONE_BY_KEY[`${s.building}|${s.floor}`];
  return !!(z && z.mapped);
}

// 카테고리 버튼 정의: { label(화면표시), emoji, terms(검색에 쓸 동의어들), fish(신선이 안내 여부) }
// 음성으로 "과일/마늘/건어물"을 말해도 매칭되도록 terms 에 동의어를 넣습니다.
const CATEGORIES = [
  { label: "청과·과일",   emoji: "🍎", terms: ["청과", "과일"] },
  { label: "채소·나물",   emoji: "🥬", terms: ["채소", "마늘", "나물"] },
  { label: "건어물·특산품", emoji: "🦑", terms: ["건어물", "팔도특산품", "특산품"], fish: true },
  { label: "수산·생선",   emoji: "🐟", terms: ["수산", "생선", "회"], fish: true },
  { label: "축산·정육",   emoji: "🥩", terms: ["축산", "정육", "고기", "한우"] },
];
// 신선이(물고기)로 안내할 품목 키워드 — 그 외에는 무농이(무)
const FISH_TERMS = ["수산", "생선", "회", "건어물", "팔도특산품", "특산품"];

// ── 초기화 ────────────────────────────────────────────────
async function init() {
  try {
    // 데이터 파일 로드 (※ file:// 직접 열기 시 fetch 차단됨 → README의 로컬 서버 사용 안내)
    // cache:"no-store" — 폰 브라우저가 옛 데이터를 캐시하지 않도록 항상 최신을 받음
    const noStore = { cache: "no-store" };
    const [storesRes, locsRes, zonesRes, plansRes] = await Promise.all([
      fetch("stores.json", noStore),
      fetch("locations.json", noStore),
      fetch("zones.json", noStore).catch(() => null),            // 선택(없어도 동작)
      fetch("floorplans/index.json", noStore).catch(() => null), // 선택(없으면 약식 지도)
    ]);
    STORES = (await storesRes.json()).stores;
    LOCATIONS = (await locsRes.json()).locations;
    if (zonesRes && zonesRes.ok) {
      const zones = (await zonesRes.json()).zones || [];
      zones.forEach((z) => { ZONE_BY_KEY[z.key] = z; });
    }
    if (plansRes && plansRes.ok) {
      PLANS = (await plansRes.json()).plans || [];
      PLANS.forEach((p) => { PLAN_BY_KEY[`${p.dong}|${p.floorCode}`] = p; });
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

// URL 파라미터(?loc=g-b1-west)로 현재 위치를 찾습니다. 없으면 첫 위치로 폴백.
function resolveCurrentLocation() {
  const params = new URLSearchParams(location.search);
  const locId = params.get("loc");
  currentLoc = LOCATIONS.find((l) => l.locId === locId) || LOCATIONS[0];
  shownDong = dongOf(currentLoc.building);
  shownFloor = currentLoc.floor;
  const locNameEl = document.getElementById("currentLocName");
  if (locNameEl) {
    locNameEl.textContent = `${shortBuilding(currentLoc.building)} ${floorLabel(currentLoc.floor)} · ${currentLoc.name}`;
  }
}

// "가락몰 판매동 청과부류" → "판매동" 같이 화면용 짧은 건물명
function shortBuilding(b) {
  return b.replace(/^가락몰\s*/, "").split(" ")[0] || b;
}

// ── 입력: 카테고리 버튼 ────────────────────────────────────
function renderCategoryButtons() {
  const box = document.getElementById("categoryButtons");
  box.innerHTML = "";
  CATEGORIES.forEach((c) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = `<span class="cat-emoji">${c.emoji}</span><span>${c.label}</span>`;
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

  // 3) 매장 선정 우선순위: 같은 층 → 평면도에 정합된 좌표(정밀 안내 가능) → 직선거리
  //    (정합 안 된 구역의 좌표는 임의 배치값이라 층간 거리 비교가 무의미하기 때문)
  const curView = viewOf(currentLoc.building, currentLoc.floor);
  const rank = (o) => {
    const sameView = viewOf(o.s.building, o.s.floor) === curView;
    const guided = !!planFor(dongOf(o.s.building), o.s.floor) && storeMapped(o.s);
    return (sameView ? 0 : 2) + (guided ? 0 : 1);
  };
  destStore = located.reduce((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra < rb ? a : b;
    return dist(currentLoc, a.xy) < dist(currentLoc, b.xy) ? a : b;
  }).s;

  showResultCard(q, destStore);
  // 입력이 성공하면 네비게이션(지도) 화면을 표시
  document.querySelector(".map-section").classList.remove("hidden");
  // 목적지가 현재 층과 다르면: 우선 현재 층을 보여줘 에스컬레이터까지 안내(2단 안내)
  const sameView = viewOf(destStore.building, destStore.floor) === curView;
  shownDong = dongOf(currentLoc.building);
  shownFloor = sameView ? destStore.floor : currentLoc.floor;
  renderFloorTabs();
  renderMap();
}

function viewOf(building, floor) { return `${dongOf(building)}|${floor}`; }

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
// 폰 방향 변화를 받아 헤딩 콘/HUD 화살표를 실시간 회전. 미지원·미허용·HTTP면 조용히
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
// 품목에 따라 마스코트가 바뀐다: 수산·건어물 계열=신선이, 그 외=무농이
function mascotFor(q) {
  const fish = FISH_TERMS.some((t) => t.includes(q) || q.includes(t));
  return fish
    ? { img: "assets/sinseoni.png", name: "신선이" }
    : { img: "assets/munongi.png", name: "무농이" };
}

function showResultCard(query, store) {
  const card = document.getElementById("resultCard");
  const sameView = viewOf(store.building, store.floor) === viewOf(currentLoc.building, currentLoc.floor);
  const xy = storeXY(store);
  const plan = planFor(dongOf(store.building), store.floor);
  const arrived = sameView && xy && dist(currentLoc, xy) < arriveR(plan);
  const m = mascotFor(query);

  const say = !sameView
    ? `${shortBuilding(store.building)} ${floorLabel(store.floor)}에 있어요! 먼저 지도의 에스컬레이터로 가서 ${floorLabel(store.floor)}으로 이동해요~`
    : arrived
    ? `바로 이 구역이에요! 도착했어요 🎉 주변 매대를 둘러보세요.`
    : `같은 ${floorLabel(store.floor)}이에요. 지도의 경로를 따라오세요!`;

  card.innerHTML = `
    <div class="mascot-say">
      <img class="mascot" src="${m.img}" alt="${m.name}" />
      <p class="bubble">${say}</p>
    </div>
    <h2>📍 ${store.name}</h2>
    <p class="store-meta"><span class="label">위치</span> ${store.building} · ${floorLabel(store.floor)} ${store.zone}</p>
    <div class="tags">${store.categories.map((c) => `<span class="tag">${c}</span>`).join("")}</div>
    ${plan && storeMapped(store) ? "" : `<p class="zone-note">지도 위 위치는 대략적인 표시입니다. 현장 안내판을 함께 확인하세요.</p>`}
  `;
  card.classList.remove("hidden");
}

function showResultMessage(msg) {
  const card = document.getElementById("resultCard");
  card.innerHTML = `
    <div class="mascot-say">
      <img class="mascot" src="assets/munongi.png" alt="무농이" />
      <p class="bubble">${msg}</p>
    </div>`;
  card.classList.remove("hidden");
  destStore = null;
  const mapSec = document.querySelector(".map-section");
  if (!mapSec.classList.contains("hidden")) renderMap();
}

// ── 층 탭 ─────────────────────────────────────────────────
// 현재 동(dong)의 평면도가 있는 층 + 현재위치/목적지 층만 탭으로 노출
function renderFloorTabs() {
  const floors = new Set();
  PLANS.filter((p) => p.dong === shownDong).forEach((p) => {
    const f = p.floorCode.startsWith("B") ? -Number(p.floorCode.slice(1)) : parseInt(p.floorCode);
    floors.add(f);
  });
  if (dongOf(currentLoc.building) === shownDong) floors.add(currentLoc.floor);
  if (destStore && dongOf(destStore.building) === shownDong) floors.add(destStore.floor);

  const tabs = document.getElementById("floorTabs");
  tabs.innerHTML = "";
  [...floors].sort((a, b) => a - b).forEach((f) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = floorLabel(f);
    btn.className = f === shownFloor ? "active" : "";
    btn.addEventListener("click", () => { shownFloor = f; renderFloorTabs(); renderMap(); });
    tabs.appendChild(btn);
  });
}

// ── 지도(SVG) 그리기 ───────────────────────────────────────
// 공식 평면도 PNG를 배경으로 깔고 현재 위치/목적지 마커 + 통로 경로를 그린다.
// 지도는 북쪽 고정. 헤딩 콘(현재위치 부채꼴)과 HUD 화살표만 사용자 방향으로 회전한다
// (전체 재렌더는 층 전환·새 목적지 때만, 나침반 갱신은 applyHeading 이 transform 만 변경).
function renderMap() {
  const svg = document.getElementById("mapSvg");
  const plan = planFor(shownDong, shownFloor);
  const vbW = plan ? plan.w : 1000;
  const vbH = plan ? plan.h : 1000;
  const k = vbW / 1000;   // 마커·선 굵기 스케일 팩터 (약식 지도=1)
  svg.setAttribute("viewBox", `0 0 ${vbW} ${vbH}`);

  const curView = viewOf(currentLoc.building, currentLoc.floor);
  const thisView = `${shownDong}|${shownFloor}`;
  const onFloorCurrent = curView === thisView;
  const destXY = destStore ? storeXY(destStore) : null;
  const destView = destStore ? viewOf(destStore.building, destStore.floor) : null;
  const onFloorDest = destView === thisView;

  let inner = "";
  // 배경: 공식 평면도 or 약식 격자
  if (plan) {
    inner += `<image href="floorplans/${plan.file}" x="0" y="0" width="${vbW}" height="${vbH}"/>`;
  } else {
    inner += drawFloorPlanBackground(shownFloor);
  }

  // 경로/마커
  const esc = plan && plan.escalator ? { x: plan.escalator[0], y: plan.escalator[1] } : null;
  if (destXY && onFloorCurrent && onFloorDest) {
    // 같은 층: 현재위치 → 목적지
    inner += routeVia(currentLoc, destXY, plan, k);
  } else if (destXY && onFloorCurrent && !onFloorDest && esc) {
    // 층간 1단계: 현재위치 → 에스컬레이터
    inner += routeVia(currentLoc, esc, plan, k);
    inner += marker(esc.x, esc.y, "#7b5cc4", "에스컬레이터", "↑", k);
  } else if (destXY && !onFloorCurrent && onFloorDest && esc) {
    // 층간 2단계: 에스컬레이터 → 목적지
    inner += routeVia(esc, destXY, plan, k);
    inner += marker(esc.x, esc.y, "#7b5cc4", "에스컬레이터", "↑", k);
  }
  if (onFloorCurrent) {
    inner += headingCone(currentLoc.x, currentLoc.y, k);
    inner += marker(currentLoc.x, currentLoc.y, "#1e7a3c", "현재위치", "●", k);
  }
  if (onFloorDest && destXY) {
    inner += marker(destXY.x, destXY.y, "#e8731a", destStore.name, "★", k);
  }
  if (DEBUG) inner += debugGrid(vbW, vbH);

  svg.innerHTML = inner;

  // 지도 타이틀
  const title = document.getElementById("mapTitle");
  if (title) {
    title.textContent = plan
      ? `${plan.label} · 공식 안내도`
      : `${shortBuilding(currentLoc.building)} ${floorLabel(shownFloor)} · 약식 안내도`;
  }

  applyHeading();   // 헤딩 콘·HUD 화살표 갱신
}

// 재렌더 없이 방향 요소만 갱신: 헤딩 콘 회전 + HUD 화살표 방향.
function applyHeading() {
  const H = activeHeading();
  const thisView = `${shownDong}|${shownFloor}`;
  const onFloor = viewOf(currentLoc.building, currentLoc.floor) === thisView;

  // 헤딩 콘: 현재위치에서 사용자가 향한 방향
  const cone = document.getElementById("headCone");
  if (cone) cone.setAttribute("transform", `rotate(${H} ${currentLoc.x} ${currentLoc.y})`);

  // HUD 방향 배지: 같은 층에 목적지가 있고 도착 전일 때만
  const hud = document.getElementById("hudBadge");
  if (!hud) return;
  const destXY = destStore ? storeXY(destStore) : null;
  const sameView = destStore &&
    viewOf(destStore.building, destStore.floor) === viewOf(currentLoc.building, currentLoc.floor);
  const plan = planFor(dongOf(currentLoc.building), currentLoc.floor);

  if (destXY && sameView && onFloor && dist(currentLoc, destXY) >= arriveR(plan)) {
    const rel = (bearingTo(currentLoc, destXY) - H + 360) % 360;
    hud.classList.remove("hidden");
    hud.querySelector(".hud-arrow").style.transform = `rotate(${rel}deg)`;
    hud.querySelector(".hud-text").textContent = "화살표 방향으로 가세요";
  } else if (destStore && !sameView) {
    hud.classList.remove("hidden");
    hud.querySelector(".hud-arrow").style.transform = "";
    hud.querySelector(".hud-arrow").textContent = "🛗";
    hud.querySelector(".hud-text").textContent = `에스컬레이터로 ${floorLabel(destStore.floor)} 이동`;
    return;
  } else {
    hud.classList.add("hidden");
  }
  hud.querySelector(".hud-arrow").textContent = "⬆";
}

// 헤딩 콘: 현재위치 마커 아래에 깔리는 부채꼴(사용자가 보는 방향).
function headingCone(x, y, k) {
  const r = 90 * k;
  const a = (25 * Math.PI) / 180;   // 반각 25°
  const x1 = x - r * Math.sin(a), y1 = y - r * Math.cos(a);
  const x2 = x + r * Math.sin(a), y2 = y - r * Math.cos(a);
  return `<g id="headCone">
    <path d="M ${x} ${y} L ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2} Z"
          fill="#1e7a3c" opacity="0.22"/>
  </g>`;
}

// 약식 평면도 배경(평면도 이미지가 없는 층 폴백): 외벽 + 통로 + 구역 블록
function drawFloorPlanBackground(floor) {
  let s = "";
  s += `<rect x="20" y="20" width="960" height="960" rx="20" fill="#ffffff" stroke="#c7d0c7" stroke-width="6"/>`;
  const blocks = [
    [70, 90, 360, 250], [560, 90, 360, 250],
    [70, 430, 360, 220], [560, 430, 360, 220],
    [70, 720, 360, 200], [560, 720, 360, 200],
  ];
  blocks.forEach(([x, y, w, h]) => {
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#eef3ee" stroke="#dce4dc" stroke-width="3"/>`;
  });
  s += `<line x1="500" y1="40" x2="500" y2="960" stroke="#cdd6cd" stroke-width="14" stroke-dasharray="2 18" stroke-linecap="round"/>`;
  s += `<line x1="40" y1="400" x2="960" y2="400" stroke="#cdd6cd" stroke-width="14" stroke-dasharray="2 18" stroke-linecap="round"/>`;
  s += `<text x="40" y="70" font-size="34" fill="#9aa89a" font-weight="700">${floorLabel(floor)} · 약식 안내도</text>`;
  return s;
}

// ── 통로 경로 ──────────────────────────────────────────────
// 점 p를 선분 a-b 에 수선 투영. {x,y,t(0~1), d(거리)} 반환.
function projectOnSegment(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby || 1;
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t * abx, y = a.y + t * aby;
  return { x, y, t, d: Math.hypot(p.x - x, p.y - y) };
}

// 점 p를 corridor polyline 전체에 투영해 가장 가까운 지점 반환. {x,y,seg,t}
function projectOnCorridor(p, poly) {
  let best = null;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = { x: poly[i][0], y: poly[i][1] };
    const b = { x: poly[i + 1][0], y: poly[i + 1][1] };
    const pr = projectOnSegment(p, a, b);
    if (!best || pr.d < best.d) best = { ...pr, seg: i };
  }
  return best;
}

// 경로: from → (통로 진입) → 통로 중심선 따라 이동 → (통로 이탈) → to
// corridor 가 없으면 기존 ㄱ자 꺾은선 폴백.
function routeVia(from, to, plan, k) {
  const corridor = plan && plan.corridor;
  let pts;
  if (corridor && corridor.length >= 2) {
    const pa = projectOnCorridor(from, corridor);
    const pb = projectOnCorridor(to, corridor);
    const mid = [];
    if (pa.seg <= pb.seg) {
      for (let i = pa.seg + 1; i <= pb.seg; i++) mid.push(corridor[i]);
    } else {
      for (let i = pa.seg; i > pb.seg; i--) mid.push(corridor[i]);
    }
    pts = [[from.x, from.y], [pa.x, pa.y], ...mid, [pb.x, pb.y], [to.x, to.y]];
  } else {
    pts = [[from.x, from.y], [from.x, to.y], [to.x, to.y]];   // ㄱ자 폴백
  }
  const d = "M " + pts.map(([x, y]) => `${Math.round(x)} ${Math.round(y)}`).join(" L ");
  const w = Math.max(4, 10 * k);
  return `<path d="${d}" fill="none" stroke="#e8731a" stroke-width="${w}"
            stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${22 * k} ${16 * k}" opacity="0.95">
            <animate attributeName="stroke-dashoffset" from="${38 * k}" to="0" dur="0.8s" repeatCount="indefinite"/>
          </path>`;
}

// 마커: 원 + 아이콘 + 라벨
function marker(x, y, color, label, glyph, k) {
  const r = Math.max(9, 24 * k);
  const fs = Math.max(9, 22 * k);
  const lw = Math.max(60, label.length * fs * 0.95 + 16 * k);
  return `
    <g>
      <circle cx="${x}" cy="${y}" r="${r}" fill="${color}" stroke="#fff" stroke-width="${Math.max(2, 5 * k)}"/>
      <text x="${x}" y="${y + fs * 0.36}" font-size="${fs}" fill="#fff" text-anchor="middle" font-weight="700">${glyph}</text>
      <g class="lbl">
        <rect x="${x - lw / 2}" y="${y + r + 4 * k}" width="${lw}" height="${fs * 1.7}" rx="${8 * k}" fill="${color}" opacity="0.95"/>
        <text x="${x}" y="${y + r + 4 * k + fs * 1.2}" font-size="${fs}" fill="#fff" text-anchor="middle" font-weight="700">${label}</text>
      </g>
    </g>`;
}

// 디버그 격자(?debug=1): 50px 간격 격자 + 좌표 라벨 — 좌표 정합 검수용
function debugGrid(w, h) {
  let s = `<g opacity="0.55">`;
  for (let x = 0; x <= w; x += 50) {
    s += `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#e11" stroke-width="0.5"/>`;
    if (x % 100 === 0) s += `<text x="${x + 2}" y="12" font-size="11" fill="#e11">${x}</text>`;
  }
  for (let y = 0; y <= h; y += 50) {
    s += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#e11" stroke-width="0.5"/>`;
    if (y % 100 === 0) s += `<text x="2" y="${y + 12}" font-size="11" fill="#e11">${y}</text>`;
  }
  return s + `</g>`;
}

// ── 음성 인식 (Web Speech API) ─────────────────────────────
function setupVoice() {
  const btn = document.getElementById("voiceBtn");
  const statusEl = document.getElementById("voiceStatus");

  const micLabel = document.querySelector(".mic-label");

  // 보안 컨텍스트 확인: 음성인식은 HTTPS(또는 localhost)에서만 동작.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const secure = window.isSecureContext;   // https/localhost = true
  if (!SR || !secure) {
    if (micLabel) micLabel.textContent = secure
      ? "이 브라우저는 음성을 지원하지 않아요 — 아래 버튼 이용"
      : "음성은 보안연결(https)에서만 돼요 — 아래 버튼 이용";
    statusEl.textContent = "지금은 음성이 안 돼요. 아래 카테고리 버튼으로 찾아보세요.";
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
