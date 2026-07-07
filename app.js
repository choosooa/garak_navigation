// 가락몰 길찾기 핵심 로직 / 생성일: 2026-06-25
// 백엔드 없이 순수 프론트엔드. stores.json / locations.json / zones.json / floorplans/index.json 을 불러와 동작합니다.
//
// 화면 흐름(3단계):
//   ① 품목 입력(음성·버튼) → ② 후보 가게 목록에서 사용자가 직접 선택 → ③ 네비게이션(지도+방향+거리)
//   ※ 최근접 매장을 자동 선정하지 않는 이유: 특정 매장이 수요를 독점하지 않도록 선택권을 방문객에게 둔다.
//
// 지도는 공식 층별 평면도 PNG(floorplans/)를 SVG 배경으로 깔고, 좌표는 해당 평면도의 픽셀좌표를 씁니다.
// 평면도가 없는 층은 약식 격자 안내도(0~1000 좌표계)로 폴백합니다.

// ── 전역 상태 ──────────────────────────────────────────────
let STORES = [];        // 매장 목록
let LOCATIONS = [];     // QR 위치 목록
let ZONE_BY_KEY = {};   // 구역 대표좌표 맵: "building|section|floor" → {x,y,mapped}
let PLANS = [];         // 평면도 인덱스 (floorplans/index.json)
let PLAN_BY_KEY = {};   // "동코드|층코드" → plan 항목 (예: "G|B1")
let currentLoc = null;  // 현재 위치(QR) 객체 — GPS·층전환으로 갱신됨
let ORIGIN_LOC = null;  // QR 스캔 원본 위치 스냅샷 ("처음으로" 시 복원용)
let destStore = null;   // 안내 중인 목적지 매장 (3단계에서만 설정)
let candidates = [];    // 2단계 후보 매장 목록 [{s, xy, r}]
let lastQuery = "";     // 마지막 검색어(가게 선택 화면 문구용)
let shownDong = null;   // 지도에 표시 중인 동코드(A~G)
let shownFloor = 1;     // 지도에 표시 중인 층

// 방향 정렬 상태 — 현재 층에서는 지도가 -heading 회전 (내 정면 = 항상 화면 위)
let USER_HEADING = null;   // 실시간 나침반 방위(0~360) — 없으면 null(QR 고정값 폴백)
let COMPASS_ON = false;    // 나침반 리스너 부착 여부(중복 부착 방지)
let COMPASS_REQUESTED = false;  // iOS 권한 요청 진행 중 플래그(비동기 중 중복 팝업 방지)
let rafPending = false;    // applyHeading rAF 예약 중복 방지

let VOICE_GUIDE = true;    // 음성 안내(TTS) 켜짐 여부 — 고령 사용자 배려 기본 ON

let TRACKING = true;       // 위치 따라가기 켜짐 (GPS 미지원·거부 환경은 QR 고정 위치로 자연 폴백)
let MAP_MODE = "follow";   // "follow"(차량 내비식) | "overview"(전체 지도 + 핀치줌·팬)
const OV = { z: 1, x: 0, y: 0 };   // overview 줌 배율(1=전체보기)·팬 오프셋(화면 px)
let lastGuideKey = null;   // 행동 지시 상태 키 — 바뀔 때만 TTS 발화 (거리 숫자 변화로는 발화 안 함)
let stepRafPending = false;

const CANDIDATE_MAX = 8;   // 가게 선택 목록 최대 표시 수 (너무 길면 고령 사용자에게 부담)
const DEBUG = new URLSearchParams(location.search).get("debug") === "1";
// 걷기 시뮬레이션 패드 — 현장 시연 전 임시로 기본 표시 (?walk=0 으로 숨김).
// ⚠️ 실서비스/현장 QR 배포 시점에는 기본을 꺼짐으로 되돌릴 것: get("walk") === "1"
const WALK_PAD = DEBUG || new URLSearchParams(location.search).get("walk") !== "0";

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
function viewOf(building, floor) { return `${dongOf(building)}|${floor}`; }

// 도착 판정 거리: 평면도 층은 픽셀좌표라 층 크기에 비례시킨다
// 도착 판정 반경: 실거리 3m (축척 있으면), 없으면 옛 근사치
function arriveR(plan) {
  if (plan && plan.mpp) return 3 / plan.mpp;
  return plan ? Math.min(plan.w, plan.h) * 0.11 : 40;
}

// 픽셀 거리 → 대략적인 미터 (평면도 축척 mpp 가 있을 때만, 5m 단위 반올림)
function approxMeters(px, plan) {
  if (!plan || !plan.mpp) return null;
  return Math.max(5, Math.round((px * plan.mpp) / 5) * 5);
}

// 매장의 지도 좌표를 구한다.
// 1순위: 매장 자체 x,y(정밀)  2순위: 자기 구역(building+section+층)의 대표좌표  없으면 null
function storeXY(s) {
  if (Number.isFinite(s.x) && Number.isFinite(s.y)) return { x: s.x, y: s.y };
  const z = ZONE_BY_KEY[`${s.building}|${s.section || ""}|${s.floor}`];
  if (z && Number.isFinite(z.x) && Number.isFinite(z.y)) return { x: z.x, y: z.y };
  return null;
}

// 위경도 → 평면도 픽셀. plan.geo.anchors 2점으로 유사변환(축척+회전) 계산.
// 원리: A 앵커 기준 동거리(ENU) 미터로 편 뒤, A→B 실벡터가 A→B 픽셀벡터로 가는
// 복소 배율 k(=s+ir)를 구해 임의 점에 적용한다. (SVG y는 남쪽+라 북+를 뒤집는다)
function geoToPx(lat, lng, plan) {
  const g = plan && plan.geo;
  if (!g || !g.anchors || g.anchors.length < 2) return null;
  const [A, B] = g.anchors;
  const M_LAT = 110950;
  const M_LNG = 111320 * Math.cos((A.ll[0] * Math.PI) / 180);
  const enu = (la, ln) => ({ x: (ln - A.ll[1]) * M_LNG, y: -(la - A.ll[0]) * M_LAT }); // y남+
  const e = enu(B.ll[0], B.ll[1]);                           // A→B 실벡터 (지도 좌표계 방향)
  const p = { x: B.px[0] - A.px[0], y: B.px[1] - A.px[1] };  // A→B 픽셀벡터
  const den = e.x * e.x + e.y * e.y;
  if (!den) return null;
  const s = (p.x * e.x + p.y * e.y) / den;                   // px = k · enu
  const r = (p.y * e.x - p.x * e.y) / den;
  const q = enu(lat, lng);
  return { x: A.px[0] + s * q.x - r * q.y, y: A.px[1] + r * q.x + s * q.y };
}

// 매장 x/y 좌표의 저작 좌표계 = G동 B1/1F/3F 평면도 크기(800×370).
// 매장 좌표는 모두 이 공간에 그려졌으므로, 이 크기의 평면도에서만 실제 위치와 정합한다.
// (B2 1100×960·타 동 평면도는 좌표계가 달라 같은 좌표를 찍으면 어긋난다)
const STORE_COORD_W = 800, STORE_COORD_H = 370;

// 매장 좌표가 대상 평면도에 정합된(믿을 수 있는) 좌표인지.
// 좌표계가 일치하는 평면도 + 그 범위 안일 때만 "정밀 안내 가능"으로 본다.
// (그 외는 위치가 대략이라 거리·마커 정밀도를 신뢰하면 안 됨)
function storeMapped(s) {
  const plan = planFor(dongOf(s.building), s.floor);
  if (!plan) return false;                                          // 평면도 없는 층
  if (plan.w !== STORE_COORD_W || plan.h !== STORE_COORD_H) return false;  // 좌표계 불일치
  const xy = storeXY(s);
  return !!xy && xy.x >= 0 && xy.x <= plan.w && xy.y >= 0 && xy.y <= plan.h;
}

// "가락몰 판매동 청과부류" → "판매동" 같이 화면용 짧은 건물명
function shortBuilding(b) {
  return b.replace(/^가락몰\s*/, "").split(" ")[0] || b;
}

// 카테고리 버튼 정의: { label(화면표시), emoji, terms(검색에 쓸 동의어들) }
// 음성으로 "과일/마늘/건어물"을 말해도 매칭되도록 terms 에 동의어를 넣습니다.
// 마지막(건어물·특산품)은 화면에서 전체 폭(wide) 버튼 — mockup 기준 5번째 배치
const CATEGORIES = [
  { label: "청과·과일",   emoji: "🍎", terms: ["청과", "과일", "사과", "배", "귤", "포도", "딸기", "수박", "참외", "복숭아", "바나나"] },
  { label: "채소·나물",   emoji: "🥬", terms: ["채소", "마늘", "나물", "양파", "대파", "배추", "무", "상추", "고추", "버섯", "감자", "고구마"] },
  { label: "수산·생선",   emoji: "🐟", terms: ["수산", "생선", "회", "고등어", "갈치", "오징어", "새우", "조개", "게", "낙지"] },
  { label: "축산·정육",   emoji: "🥩", terms: ["축산", "정육", "고기", "한우", "소고기", "돼지고기", "삼겹살", "닭", "닭고기", "오리"] },
  { label: "건어물·특산품", emoji: "🦑", terms: ["건어물", "팔도특산품", "특산품", "멸치", "김", "미역", "다시마", "견과"] },
];
// 신선이(물고기)로 안내할 품목 키워드 — 그 외에는 무농이(무)
const FISH_TERMS = ["수산", "생선", "회", "건어물", "팔도특산품", "특산품", "젓갈"];
const FISH_CAT_LABELS = ["수산·생선", "건어물·특산품"];   // 신선이 담당 카테고리

function mascotFor(q) {
  // "갈치"처럼 구체 품목을 말해도 카테고리 사전으로 먼저 판별 (handleQuery 와 같은 확장 규칙)
  const catDef = CATEGORIES.find((c) => c.terms.some((t) => t === q || q.includes(t)));
  const fish = catDef
    ? FISH_CAT_LABELS.includes(catDef.label)
    : FISH_TERMS.some((t) => t.includes(q) || q.includes(t));
  return fish
    ? { img: "assets/sinseoni.png", name: "신선이" }
    : { img: "assets/munongi.png", name: "무농이" };
}

// ── 음성 안내(TTS) — 고령 사용자 배려 ─────────────────────
function speak(text) {
  if (!VOICE_GUIDE || !window.speechSynthesis) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ko-KR";
    u.rate = 0.95;   // 살짝 천천히
    speechSynthesis.speak(u);
  } catch (_) { /* 미지원 환경은 조용히 무시 */ }
}

// ── 3단계 화면 전환 ────────────────────────────────────────
const STEP_IDS = { input: "stepInput", select: "stepSelect", nav: "stepNav" };
function goStep(step) {
  Object.entries(STEP_IDS).forEach(([k, id]) => {
    document.getElementById(id).classList.toggle("hidden", k !== step);
  });
  window.scrollTo({ top: 0, behavior: "instant" });
}

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
    if (!Array.isArray(LOCATIONS) || LOCATIONS.length === 0) {
      showFatal("위치(QR) 데이터가 비어 있습니다. locations.json 을 확인해주세요.");
      return;
    }
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

  assignStalls();             // 벡터 층: 호수 규칙으로 매장별 좌표 자동 부여 + 보행 격자
  resolveCurrentLocation();   // URL ?loc= 로 현재 위치 결정
  renderCategoryButtons();    // 카테고리 버튼 생성
  setupSearchInput();         // 텍스트 검색창
  setupVoice();               // 음성 인식 준비
  setupNavButtons();          // 2·3단계 버튼(뒤로/처음/음성안내) 연결
  setupWalkPad();             // ?debug=1 걷기 시뮬레이션 패드

  // 데모·테스트용 딥링크: ?go=과일 → 자동 검색, &pick=1 → N번째 가게로 바로 안내
  const params = new URLSearchParams(location.search);
  const goQ = params.get("go");
  if (goQ) {
    handleQuery(goQ);
    const pick = parseInt(params.get("pick"));
    if (pick && candidates[pick - 1]) selectStore(candidates[pick - 1].s);
  }

  // 데모·테스트용 가짜 GPS: ?gps=37.4944,127.1157 (1회 주입)
  const fakeGps = params.get("gps");
  if (fakeGps) {
    const [la, ln] = fakeGps.split(",").map(Number);
    if (Number.isFinite(la) && Number.isFinite(ln)) window.__gps(la, ln);
  }
}

// URL 파라미터(?loc=g-b1-west)로 현재 위치를 찾습니다. 없으면 첫 위치로 폴백.
function resolveCurrentLocation() {
  const params = new URLSearchParams(location.search);
  const locId = params.get("loc");
  currentLoc = LOCATIONS.find((l) => l.locId === locId) || LOCATIONS[0];
  ORIGIN_LOC = { ...currentLoc };   // 원본 QR 스냅샷 보관 (GPS·층전환 전)
  shownDong = dongOf(currentLoc.building);
  shownFloor = currentLoc.floor;
  updateLocChip();
}

// 헤더의 현재 위치 칩 갱신
function updateLocChip() {
  const el = document.getElementById("currentLocName");
  if (el) el.textContent = `${shortBuilding(currentLoc.building)} ${floorLabel(currentLoc.floor)} · ${currentLoc.name}`;
}

// ── 1단계: 입력 ────────────────────────────────────────────
function renderCategoryButtons() {
  const box = document.getElementById("categoryButtons");
  box.innerHTML = "";
  CATEGORIES.forEach((c, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat-btn" + (i === CATEGORIES.length - 1 ? " wide" : "");
    btn.innerHTML = `<span class="emoji">${c.emoji}</span>${c.label}`;
    btn.addEventListener("click", () => { enableCompass(); handleQuery(c.terms[0]); });
    box.appendChild(btn);
  });
}

// 텍스트 검색창 — 음성·버튼과 같은 handleQuery 를 탄다
function setupSearchInput() {
  const form = document.getElementById("searchForm");
  const input = document.getElementById("searchInput");
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    enableCompass();          // 카테고리 버튼과 동일: 첫 상호작용에서 나침반 권한 요청
    handleQuery(input.value);
    input.blur();             // 모바일 키보드 닫기
  });
}

// ── 2단계: 후보 검색 → 가게 선택 목록 ──────────────────────
// 입력어 → 취급 매장 필터 → 정렬(같은 층 → 정합 좌표 → 거리) → 상위 CANDIDATE_MAX곳 표시
// quiet=true 면 TTS 없이 목록만 갱신 (네비에서 "다른 가게"로 되돌아올 때 재정렬용)
function handleQuery(query, quiet) {
  const q = String(query).trim();
  if (!q) return;

  // 1) 동의어 확장: 말한 단어("고기","사과" 등)가 카테고리 사전(terms)에 있으면
  //    그 카테고리의 대표어 전체로 검색한다 (매장 categories 는 "축산","청과" 같은 분류명이라서)
  const catDef = CATEGORIES.find((c) => c.terms.some((t) => t === q || q.includes(t)));
  const queries = catDef ? [...new Set([q, ...catDef.terms])] : [q];

  // 2) 입력어(확장어 포함)를 취급하는 매장 필터
  const matches = STORES.filter((s) =>
    s.categories.some((cat) => queries.some((t) => cat.includes(t) || t.includes(cat)))
  );
  if (matches.length === 0) {
    goStep("input");   // 검색은 1단계에서만 하므로 안내도 1단계에서 보여준다
    showInputNotice(`'${q}' 를 파는 매장을 찾지 못했어요. 다른 품목을 눌러보세요.`);
    return;
  }

  // 3) 지도 좌표가 있는 매장만 안내 후보로
  const located = matches.map((s) => ({ s, xy: storeXY(s) })).filter((o) => o.xy);
  if (located.length === 0) {
    showInputNotice(`'${q}' 취급 매장을 ${matches.length}곳 찾았지만 아직 지도 좌표가 없어요.`);
    return;
  }

  // 4) 정렬 우선순위: 같은 층 → 평면도에 정합된 좌표(정밀 안내 가능) → 직선거리
  //    (정합 안 된 구역의 좌표는 임의 배치값이라 층간 거리 비교가 무의미하기 때문)
  const curView = viewOf(currentLoc.building, currentLoc.floor);
  const rank = (o) => {
    const sameView = viewOf(o.s.building, o.s.floor) === curView;
    const guided = !!planFor(dongOf(o.s.building), o.s.floor) && storeMapped(o.s);
    return (sameView ? 0 : 2) + (guided ? 0 : 1);
  };
  located.forEach((o) => { o.r = rank(o); o.d = dist(currentLoc, o.xy); });
  located.sort((a, b) => (a.r - b.r) || (a.d - b.d) || a.s.name.localeCompare(b.s.name, "ko"));

  lastQuery = q;
  candidates = located.slice(0, CANDIDATE_MAX);
  renderStoreList(matches.length);
  goStep("select");
  if (!quiet) speak(`${q} 파는 가게 ${matches.length}곳을 찾았어요. 갈 가게를 골라주세요.`);
}

// 입력 화면 안의 안내 문구(검색 실패 등)
function showInputNotice(msg) {
  const el = document.getElementById("voiceStatus");
  el.textContent = msg;
  speak(msg);
}

// 후보 카드의 거리 칩 내용: dist(주황 큰 글씨) + where(보조 위치 문구)
function candidateMeta(o) {
  const sameView = viewOf(o.s.building, o.s.floor) === viewOf(currentLoc.building, currentLoc.floor);
  if (sameView) {
    const plan = planFor(dongOf(o.s.building), o.s.floor);
    const m = approxMeters(o.d, plan);
    return { dist: m ? `약 ${m}m` : "같은 층", where: `같은 층 · ${o.s.zone}` };
  }
  const mapped = storeMapped(o.s) && planFor(dongOf(o.s.building), o.s.floor);
  return mapped
    ? { dist: floorLabel(o.s.floor), where: `에스컬레이터 이용 · ${o.s.zone}` }
    : { dist: floorLabel(o.s.floor), where: `${shortBuilding(o.s.building)} · 위치 대략` };
}

function renderStoreList(totalCount) {
  const m = mascotFor(lastQuery);
  document.getElementById("selectMascot").src = m.img;
  document.getElementById("selectBubble").innerHTML =
    `<span class="q">'${lastQuery}'</span> 파는 가게예요.<br />가고 싶은 곳을 눌러주세요!`;
  document.getElementById("selectHint").innerHTML =
    totalCount > candidates.length
      ? `가까운 순서로 ${candidates.length}곳을 보여드려요 <span class="dim">(전체 ${totalCount}곳)</span>`
      : `가까운 순서로 보여드려요`;

  const list = document.getElementById("storeList");
  list.innerHTML = "";
  candidates.forEach((o, i) => {
    const meta = candidateMeta(o);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "store-card";
    card.innerHTML = `
      <span class="store-top">
        <span class="rank">${i + 1}</span>
        <span class="store-name">${o.s.name}</span>
        <span class="store-tag">${o.s.categories[0] || ""}</span>
      </span>
      <span class="store-bottom">
        <span class="dist-chip"><span class="dist">${meta.dist}</span><span class="where">${meta.where}</span></span>
        <span class="go-btn">안내 <span class="arrow">▶</span></span>
      </span>`;
    card.addEventListener("click", () => { enableCompass(); selectStore(o.s); });
    list.appendChild(card);
  });
  if (candidates.length >= 4) {
    const hint = document.createElement("p");
    hint.className = "more-hint";
    hint.textContent = "아래로 밀어서 더 보기 ↓";
    list.appendChild(hint);
  }
}

// ── 3단계: 네비게이션 ─────────────────────────────────────
function selectStore(store) {
  destStore = store;
  const xy = storeXY(store);
  const sameView = viewOf(store.building, store.floor) === viewOf(currentLoc.building, currentLoc.floor);

  // 위치 추적 준비: 사용자 제스처(카드 탭) 안에서 GPS 권한 확보 + 지시 상태 초기화
  lastGuideKey = null;
  enableGPS();

  // 지도: 층간이면 현재 층부터 (에스컬레이터까지 1단계 안내)
  shownDong = dongOf(currentLoc.building);
  shownFloor = sameView ? store.floor : currentLoc.floor;
  renderFloorTabs();
  goStep("nav");    // 먼저 화면을 보이게 한 뒤 렌더 (숨김 상태에선 배치 크기가 0으로 계산됨)
  renderMap();

  // 음성 안내 (네비게이션 시작)
  const plan = planFor(dongOf(store.building), store.floor);
  if (sameView && xy) {
    const meters = approxMeters(dist(currentLoc, xy), plan);
    speak(meters
      ? `${store.name}까지 약 ${meters}미터입니다. 화살표 방향으로 이동하세요.`
      : `${store.name}으로 안내를 시작합니다. 화살표 방향으로 이동하세요.`);
  } else {
    speak(`${store.name}은 ${floorLabel(store.floor)}에 있습니다. 먼저 에스컬레이터로 이동하세요.`);
  }
}

function setupNavButtons() {
  document.getElementById("backToInput").addEventListener("click", () => {
    document.getElementById("voiceStatus").textContent = "";
    goStep("input");
  });
  document.getElementById("backToSelect").addEventListener("click", () => {
    destStore = null;
    // 층 전환 등으로 현재 위치가 바뀌었을 수 있으니 같은 검색어로 재정렬 (무발화)
    if (lastQuery) handleQuery(lastQuery, true);
    else goStep("select");
  });
  document.getElementById("restartBtn").addEventListener("click", () => {
    destStore = null;
    candidates = [];
    // 층전환·GPS로 옮겨진 현재 위치를 QR 스캔 원본으로 되돌림
    if (ORIGIN_LOC) {
      currentLoc = { ...ORIGIN_LOC };
      shownDong = dongOf(currentLoc.building);
      shownFloor = currentLoc.floor;
      updateLocChip();
    }
    document.getElementById("voiceStatus").textContent = "";
    goStep("input");
  });
  // 층간 이동/안내 종료 큰 버튼
  const floorGoBtn = document.getElementById("floorGoBtn");
  floorGoBtn.addEventListener("click", () => {
    if (floorGoBtn.dataset.mode === "floor") arriveOnDestFloor();
    else document.getElementById("restartBtn").click();
  });
  // 위치 따라가기(GPS) 토글 (미지원·거부 환경은 QR 고정 위치로 자연 폴백)
  const trackBtn = document.getElementById("trackBtn");
  trackBtn.addEventListener("click", () => {
    TRACKING = !TRACKING;
    trackBtn.classList.toggle("off", !TRACKING);
    if (TRACKING) {
      enableGPS();   // 사용자 제스처 안에서 권한 요청
      speak("위치 따라가기를 켰어요. 걸으면 지도 위 내 위치가 움직여요.");
    } else {
      disableGPS();
      speak("위치 따라가기를 껐어요.");
    }
  });

  const ttsBtn = document.getElementById("ttsBtn");
  ttsBtn.addEventListener("click", () => {
    VOICE_GUIDE = !VOICE_GUIDE;
    ttsBtn.textContent = VOICE_GUIDE ? "🔊" : "🔇";
    ttsBtn.classList.toggle("off", !VOICE_GUIDE);
    if (!VOICE_GUIDE && window.speechSynthesis) speechSynthesis.cancel();
    if (VOICE_GUIDE) speak("음성 안내를 켰어요.");
  });

  // 전체 지도 ↔ 안내 화면 전환 (텍스트 칩 — 뜻이 바로 읽히게)
  const mapModeBtn = document.getElementById("mapModeBtn");
  mapModeBtn.addEventListener("click", () => {
    MAP_MODE = MAP_MODE === "follow" ? "overview" : "follow";
    OV.z = 1; OV.x = 0; OV.y = 0;   // 전환 시 전체보기로 리셋
    mapModeBtn.textContent = MAP_MODE === "overview" ? "🧭 안내로" : "🗺 전체 지도";
    document.getElementById("zoomBtns").classList.toggle("hidden", MAP_MODE !== "overview");
    renderMap();   // 모드에 따라 마커 화면크기 보정이 달라져 재렌더
    speak(MAP_MODE === "overview"
      ? "전체 지도예요. 더하기 빼기 버튼으로 확대해 보세요."
      : "안내 화면으로 돌아왔어요.");
  });
  // 확대/축소 버튼 (전체 지도 모드 전용, 핀치 대체)
  const zoomStep = (mul) => {
    OV.z = Math.max(1, Math.min(12, OV.z * mul));
    onPositionChanged();
  };
  document.getElementById("zoomInBtn").addEventListener("click", () => zoomStep(1.45));
  document.getElementById("zoomOutBtn").addEventListener("click", () => zoomStep(1 / 1.45));
  setupMapGestures();

  window.addEventListener("resize", () => layoutMap());
}

// ── 전체 지도 모드 제스처: 드래그 팬 + 핀치/휠 줌 ─────────
function setupMapGestures() {
  const stage = document.getElementById("mapStage");
  const ptrs = new Map();   // pointerId → 마지막 좌표
  let lastPinch = null;     // 두 손가락 사이 거리

  stage.addEventListener("pointerdown", (e) => {
    if (MAP_MODE !== "overview") return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (MAP_MODE !== "overview" || !ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) {                    // 한 손가락: 팬
      OV.x += e.clientX - prev.x;
      OV.y += e.clientY - prev.y;
      layoutMap();
    } else if (ptrs.size === 2) {             // 두 손가락: 핀치 줌
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinch) {
        OV.z = Math.max(1, Math.min(12, OV.z * (d / lastPinch)));
        onPositionChanged();   // 마커는 화면 고정 크기라 줌 변경 시 재렌더 필요
      }
      lastPinch = d;
    }
  });
  ["pointerup", "pointercancel"].forEach((t) =>
    stage.addEventListener(t, (e) => { ptrs.delete(e.pointerId); lastPinch = null; }));
  // 데스크톱: 휠 줌
  stage.addEventListener("wheel", (e) => {
    if (MAP_MODE !== "overview") return;
    e.preventDefault();
    OV.z = Math.max(1, Math.min(12, OV.z * (e.deltaY < 0 ? 1.15 : 0.87)));
    onPositionChanged();   // 마커는 화면 고정 크기라 줌 변경 시 재렌더 필요
  }, { passive: false });
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

// 현재 사용할 방위: 실시간 나침반 > QR 고정값
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
  if (COMPASS_ON || COMPASS_REQUESTED) return;   // 이미 부착됐거나 권한 요청 진행 중이면 무시
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
    // iOS Safari: 제스처 동기 경로에서 권한 팝업 (비동기 resolve 전 재호출 차단)
    COMPASS_REQUESTED = true;
    DOE.requestPermission()
      .then((res) => { if (res === "granted") attach(); })
      .catch(() => {})
      .finally(() => { COMPASS_REQUESTED = false; });
  } else {
    attach();   // Android/기타
  }
}

// ── GPS 위치 추적 ──────────────────────────────────────────
// watchPosition 으로 위치를 받아 지오 앵커(geoToPx)로 평면도 픽셀에 사영한다.
// 실내(지하)는 정확도가 나쁘므로 accuracy 게이트로 거르고, 통과분만 저역 필터로 반영.
// 층 판단은 GPS 로 불가 — 층은 QR/층탭이 결정하고 GPS 는 x,y 만 움직인다.
let GPS_WATCH = null;
const GPS_MAX_ACC = 35;   // m — 이보다 부정확한 픽스는 무시 (지하 폴백)

function enableGPS() {
  if (GPS_WATCH != null || !TRACKING) return;
  if (!window.isSecureContext || !("geolocation" in navigator)) return;
  GPS_WATCH = navigator.geolocation.watchPosition(onGPS, () => { /* 거부·실패 → QR 고정 폴백 */ }, {
    enableHighAccuracy: true, maximumAge: 2000, timeout: 15000,
  });
}
function disableGPS() {
  if (GPS_WATCH != null) { navigator.geolocation.clearWatch(GPS_WATCH); GPS_WATCH = null; }
}

function onGPS(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  if (DEBUG) gpsDebugHud(lat, lng, accuracy);
  if (!TRACKING || accuracy > GPS_MAX_ACC) return;
  const plan = planFor(dongOf(currentLoc.building), currentLoc.floor);
  const p = plan && geoToPx(lat, lng, plan);
  if (!p) return;                                   // 앵커 없는 층 → QR 고정
  // 평면도 범위 밖(몰 밖·원거리) 픽스는 무시 — 모서리에 강제로 붙이면 위치가 튄다
  if (p.x < -30 || p.x > plan.w + 30 || p.y < -30 || p.y > plan.h + 30) return;
  const nx = Math.max(10, Math.min(plan.w - 10, p.x));
  const ny = Math.max(10, Math.min(plan.h - 10, p.y));
  if (!currentLoc._live) currentLoc = { ...currentLoc, _live: true };   // 원본 QR 데이터 보호
  currentLoc.x = currentLoc.x * 0.6 + nx * 0.4;     // 저역 필터(튐 완화)
  currentLoc.y = currentLoc.y * 0.6 + ny * 0.4;
  onPositionChanged();
}

// 디버그: ?debug=1 이면 원시 GPS 를 화면 좌하단에 표시 (현장 앵커 검증용)
function gpsDebugHud(lat, lng, acc) {
  let el = document.getElementById("gpsHud");
  if (!el) {
    el = document.createElement("div");
    el.id = "gpsHud";
    el.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99;background:rgba(0,0,0,0.65);color:#0f0;font:12px monospace;padding:4px 8px;border-radius:6px;";
    document.body.appendChild(el);
  }
  el.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)} ±${Math.round(acc)}m`;
}

// 콘솔·데모용 훅: 가짜 GPS 주입 (?gps=위도,경도 또는 __gps(lat,lng))
window.__gps = (lat, lng, acc = 5) =>
  onGPS({ coords: { latitude: lat, longitude: lng, accuracy: acc } });

// 데모·테스트용 수동 이동: GPS 없이 걷기 시뮬레이션 (실내 데모·데스크톱 테스트)
// forward: 바라보는 방향으로 m 미터 전진(음수=후진), turn: 방위 회전(도)
window.__walk = (forwardM = 2, turnDeg = 0) => {
  if (!currentLoc._live) currentLoc = { ...currentLoc, _live: true };
  if (turnDeg) currentLoc.heading = ((currentLoc.heading ?? 0) + turnDeg + 360) % 360;
  if (forwardM) {
    const plan = planFor(dongOf(currentLoc.building), currentLoc.floor);
    const px = forwardM / ((plan && plan.mpp) || 0.31);   // 미터 → 평면도 픽셀
    const h = (activeHeading() * Math.PI) / 180;
    currentLoc.x += px * Math.sin(h);
    currentLoc.y -= px * Math.cos(h);
  }
  onPositionChanged();
};

// ?walk=1 또는 ?debug=1 이면 걷기 패드 표시 — [↺ 좌회전] [▲ 전진] [▼ 후진] [↻ 우회전]
function setupWalkPad() {
  if (!WALK_PAD) return;
  const pad = document.createElement("div");
  pad.style.cssText = "position:fixed;left:10px;bottom:120px;z-index:99;display:flex;gap:6px;";
  [["↺", () => __walk(0, -30)], ["▲", () => __walk(2)], ["▼", () => __walk(-2)], ["↻", () => __walk(0, 30)]]
    .forEach(([t, fn]) => {
      const b = document.createElement("button");
      b.textContent = t;
      b.style.cssText = "width:44px;height:44px;border-radius:10px;border:none;background:rgba(30,60,40,.75);color:#fff;font-size:20px;";
      b.addEventListener("click", fn);
      pad.appendChild(b);
    });
  document.body.appendChild(pad);
}

// 위치 변경 후: 지도 재렌더(경로·마커·행동 지시 갱신 — 도착 판정은 guidance가 담당)
function onPositionChanged() {
  if (!stepRafPending) {
    stepRafPending = true;
    requestAnimationFrame(() => { stepRafPending = false; renderMap(); });
  }
}

// ── 행동 지시 (차량 내비식) ────────────────────────────────
// 현재 위치 층 기준으로 "지금 뭘 해야 하는지"를 계산한다 (보고 있는 층과 무관).
// key = 상태 식별자 — 같은 상태에서 거리 숫자만 바뀌면 TTS 를 다시 말하지 않기 위한 값.

// 폴리라인에서 첫 굽이(≥35°)까지의 누적 거리와 방향을 찾는다.
// 8px 미만 짧은 세그먼트는 방위 노이즈라 방향 판정에서 제외(거리에는 포함).
function nextTurn(pts) {
  let acc = 0, prevBear = null;
  for (let i = 1; i < pts.length; i++) {
    const a = { x: pts[i - 1][0], y: pts[i - 1][1] };
    const b = { x: pts[i][0], y: pts[i][1] };
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg >= 8) {
      const bear = bearingTo(a, b);
      if (prevBear != null) {
        const diff = ((bear - prevBear + 540) % 360) - 180;
        if (diff <= -35) return { distPx: acc, dir: "왼쪽" };
        if (diff >= 35) return { distPx: acc, dir: "오른쪽" };
      }
      prevBear = bear;
    }
    acc += seg;
  }
  return { distPx: acc, dir: null };   // 끝까지 직진
}

// 경로 첫 유효 구간(8px 이상)의 방위각. 없으면 null.
function firstSegBearing(pts) {
  for (let i = 1; i < pts.length; i++) {
    const a = { x: pts[i - 1][0], y: pts[i - 1][1] };
    const b = { x: pts[i][0], y: pts[i][1] };
    if (Math.hypot(b.x - a.x, b.y - a.y) >= 8) return bearingTo(a, b);
  }
  return null;
}

function computeGuidance() {
  if (!destStore) return null;
  const curPlan = planFor(dongOf(currentLoc.building), currentLoc.floor);
  const destXY = storeXY(destStore);
  const sameView = viewOf(destStore.building, destStore.floor) === viewOf(currentLoc.building, currentLoc.floor);
  const crossDong = dongOf(destStore.building) !== dongOf(currentLoc.building);
  // 다른 건물(동)이면 현재 동 에스컬레이터로 유도하지 않는다 (연결되지 않으므로).
  const esc = (!crossDong && curPlan && curPlan.escalator)
    ? { x: curPlan.escalator[0], y: curPlan.escalator[1] } : null;
  const target = sameView ? destXY : esc;

  if (!target) {
    if (crossDong) {
      const bld = shortBuilding(destStore.building);
      return { key: "cross-bld", icon: "🏢",
               main: `${bld}으로 이동`, next: `${floorLabel(destStore.floor)} · 안내소에 문의하세요`,
               speak: `${destStore.name}은 ${bld}에 있어요. 그쪽으로 이동한 뒤 안내소에 문의하세요.` };
    }
    return { key: "map", icon: "🧭", main: "지도를 참고하세요", next: "", speak: null };
  }

  const remain = dist(currentLoc, target);
  // 도착 판정
  if (sameView && remain < arriveR(curPlan)) {
    return { key: "arrive", icon: "🎉", main: "도착했어요!", next: `${destStore.name} ${destStore.zone || ""}`.trim(),
             speak: `${destStore.name}에 도착했어요! 주변 매대를 둘러보세요.` };
  }
  if (!sameView && remain < arriveR(curPlan) * 0.8) {
    const fl = floorLabel(destStore.floor);
    if (dongOf(destStore.building) === dongOf(currentLoc.building)) {
      const move = destStore.floor > currentLoc.floor ? "올라가세요" : "내려가세요";
      return { key: "esc-arrive", icon: "🛗", main: `에스컬레이터로 ${fl}`, next: move,
               speak: `에스컬레이터를 타고 ${fl}으로 ${move}.` };
    }
    // 다른 건물(동): 에스컬레이터가 아니라 건물 이동 안내
    const bld = shortBuilding(destStore.building);
    return { key: "esc-arrive", icon: "🚶", main: `${bld} ${fl}으로`, next: "이동하세요",
             speak: `${bld} ${fl}으로 이동하세요.` };
  }

  const pts = computeRoutePts(currentLoc, target, curPlan);

  // 역방향 감지 — 실제 나침반이 있을 때만(폴백 QR 고정값으론 오판 위험).
  // 걷기 시뮬레이션(?walk=1)은 이동 방향이 곧 시선이라 감지 대상에 포함.
  // 경로 첫 구간과 내가 보는 방향이 크게 어긋나면 방향부터 바로잡게 한다.
  // 히스테리시스(진입 120°/해제 100°)로 경계에서 지시가 튀는 것을 방지.
  if (USER_HEADING != null || WALK_PAD) {
    const first = firstSegBearing(pts);
    if (first != null) {
      const diff = Math.abs(((first - activeHeading() + 540) % 360) - 180);
      const limit = lastGuideKey === "turnback" ? 100 : 120;
      if (diff > limit) {
        return { key: "turnback", icon: "↩", main: "뒤로 도세요", next: "반대 방향이에요",
                 speak: "반대 방향이에요. 뒤로 돌아주세요." };
      }
    }
  }

  const t = nextTurn(pts);
  const suffix = sameView ? "" : "에스컬레이터 방면";
  if (t.dir && t.distPx < 15) {
    return { key: `soon-${t.dir}`, icon: t.dir === "왼쪽" ? "↰" : "↱",
             main: `잠시 후 ${t.dir}`, next: suffix, speak: `잠시 후 ${t.dir}으로 도세요.` };
  }
  if (t.dir) {
    const m = approxMeters(t.distPx, curPlan);
    return { key: `straight-${t.dir}`, icon: "⬆",
             main: m ? `${m}m 직진` : "직진",
             next: [`다음에 ${t.dir}이에요`, suffix].filter(Boolean).join(" · "),
             speak: `${m ? `${m}미터 ` : ""}직진 후 ${t.dir}으로 도세요.` };
  }
  const m = approxMeters(remain, curPlan);
  return { key: "straight-final", icon: "⬆",
           main: m ? `${m}m 직진` : "직진", next: suffix,
           speak: "화살표 방향으로 직진하세요." };
}

// 행동 지시 갱신 — 상단 안내 바(한 줄) + 음성(TTS).
// silent=true 면 발화 없이 상태만 맞춘다 (안내 시작 직후 중복 발화 방지).
function updateGuidance(silent) {
  const g = computeGuidance();
  if (!g) return;
  document.getElementById("guideIcon").textContent = g.icon;
  document.getElementById("guideText").textContent = g.main;
  document.getElementById("guideNext").textContent = g.next || "";
  // 도착하면 안내 바를 주황(arrived)으로 전환
  const bar = document.getElementById("instrBar");
  bar.classList.toggle("arrived", g.key === "arrive");
  bar.classList.toggle("going", g.key !== "arrive");
  updateFloorGoBtn(g);
  if (g.key !== lastGuideKey) {
    if (!silent && g.speak) speak(g.speak);
    lastGuideKey = g.key;
  }
}

// 하단 큰 버튼: 층간 안내 중엔 "○층에 도착하면 누르세요", 도착하면 "안내 마치기".
// (에스컬레이터를 탄 걸 앱이 알 수 없으므로 방문객이 직접 눌러 층 전환을 알린다)
function updateFloorGoBtn(g) {
  const btn = document.getElementById("floorGoBtn");
  const cross = destStore &&
    viewOf(destStore.building, destStore.floor) !== viewOf(currentLoc.building, currentLoc.floor);
  if (cross) {
    const fl = floorLabel(destStore.floor);
    if (dongOf(destStore.building) === dongOf(currentLoc.building)) {
      const dir = destStore.floor > currentLoc.floor ? "올라가서" : "내려가서";
      btn.innerHTML = `🛗 에스컬레이터로 ${dir} <b>${fl} 도착하면 누르세요</b>`;
    } else {
      btn.innerHTML = `🚶 <b>${shortBuilding(destStore.building)} ${fl}</b>에 도착하면 누르세요`;
    }
    btn.dataset.mode = "floor";
    btn.classList.remove("hidden");
  } else if (g && g.key === "arrive") {
    btn.innerHTML = `🏠 안내 마치기`;
    btn.dataset.mode = "done";
    btn.classList.remove("hidden");
  } else {
    btn.classList.add("hidden");
  }
}

// 층 전환: 방문객이 도착 층 버튼을 누르면 현재 위치를 그 층 에스컬레이터로 옮기고
// 화면을 전환해 두 번째 구간(에스컬레이터 → 매장) 안내를 이어간다.
function arriveOnDestFloor() {
  if (!destStore) return;
  const dong = dongOf(destStore.building);
  const plan = planFor(dong, destStore.floor);
  const esc = plan && plan.escalator;
  const fallback = storeXY(destStore) || { x: 500, y: 500 };
  currentLoc = {
    ...currentLoc, _live: true,
    building: destStore.building, floor: destStore.floor,
    x: esc ? esc[0] : fallback.x,
    y: esc ? esc[1] : fallback.y,
    name: "에스컬레이터 앞",
  };
  // 나침반 없는 환경 대비: 2구간 진행 방향을 기본 정면으로 (나침반이 있으면 무시됨)
  const secondLeg = firstSegBearing(computeRoutePts(currentLoc, storeXY(destStore), plan));
  if (secondLeg != null) currentLoc.heading = secondLeg;
  shownDong = dong;
  shownFloor = destStore.floor;
  lastGuideKey = null;   // 새 층 지시를 새로 발화
  updateLocChip();
  const stage = document.getElementById("mapStage");
  stage.classList.remove("floor-flash");
  void stage.offsetWidth;               // 애니메이션 재시작 트릭
  stage.classList.add("floor-flash");
  renderFloorTabs();
  renderMap();
  speak(`${floorLabel(destStore.floor)}입니다. 화살표 방향으로 ${destStore.name}까지 이동하세요.`);
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
    requestAnimationFrame(() => {
      rafPending = false;
      applyHeading();          // 지도·콘 회전
      updateGuidance(false);   // 몸을 돌리면 "뒤로 도세요" 같은 지시도 즉시 갱신
    });
  }
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
    // 현재위치/목적지 층은 라벨에 표시해 헷갈리지 않게 (mockup: "지하1층 · 지금")
    let suffix = "";
    if (dongOf(currentLoc.building) === shownDong && f === currentLoc.floor) suffix = " · 지금";
    else if (destStore && dongOf(destStore.building) === shownDong && f === destStore.floor) suffix = " · 목적지";
    btn.textContent = floorLabel(f) + suffix;
    btn.className = "floor-tab " + (f === shownFloor ? "on" : "off");
    btn.addEventListener("click", () => { shownFloor = f; renderFloorTabs(); renderMap(); });
    tabs.appendChild(btn);
  });
}

// ── 지도(SVG) 그리기 ───────────────────────────────────────
// 공식 평면도 PNG를 배경으로 깔고 현재 위치/목적지 마커 + 통로 경로를 그린다.
// 현재 위치 층에서는 지도가 -heading 회전(내 정면=화면 위, 헤딩 콘은 화면 기준 고정)
// (전체 재렌더는 층 전환·새 목적지 때만, 나침반 갱신은 applyHeading 이 transform 만 변경).
function renderMap() {
  if (document.getElementById("stepNav").classList.contains("hidden")) return;   // 네비 화면에서만
  const svg = document.getElementById("mapSvg");
  const plan = planFor(shownDong, shownFloor);
  const vbW = plan ? plan.w : 1000;
  const vbH = plan ? plan.h : 1000;
  const k = vbW / 1000;   // 마커·선 굵기 스케일 팩터 (약식 지도=1)
  svg.setAttribute("viewBox", `0 0 ${vbW} ${vbH}`);

  const curView = viewOf(currentLoc.building, currentLoc.floor);
  const thisView = `${shownDong}|${shownFloor}`;
  const onFloorCurrent = curView === thisView;
  // 좌표계가 다른 층의 매장(H2)은 화면 밖으로 나갈 수 있어 평면도 범위로 가둔다
  const clampToPlan = (p) => p && { x: Math.max(6, Math.min(vbW - 6, p.x)), y: Math.max(6, Math.min(vbH - 6, p.y)) };
  const destXY = destStore ? clampToPlan(storeXY(destStore)) : null;
  const destView = destStore ? viewOf(destStore.building, destStore.floor) : null;
  const onFloorDest = destView === thisView;

  // 현재 화면 배율 추정 (layoutMap 과 같은 식) — 배경 라벨·마커의 화면 고정 크기 보정용
  const stageEl = document.getElementById("mapStage");
  const svw = stageEl.clientWidth || 390, svh = stageEl.clientHeight || 700;
  const fitEst = Math.min(svw / vbW, svh / vbH);
  const fEst = MAP_MODE === "overview"
    ? fitEst * OV.z
    : (curView === thisView ? Math.max(fitEst, followScale()) : fitEst);

  let inner = "";
  // 배경: 벡터 안내도(선명·라벨 역회전) > 공식 평면도 이미지 > 약식(synthetic) > 격자 폴백
  const vKey = plan ? `${plan.dong}|${plan.floorCode}` : "";
  const vSpec = FLOOR_SPECS[vKey];
  // 2.5D 기울임: 차량 내비(따라가기) 근접 뷰에서만. 지도 모드(🗺)·PNG 층은 평면.
  document.getElementById("mapStage").classList.toggle("tilted",
    !!vSpec && MAP_MODE === "follow" && onFloorCurrent);
  if (vSpec) {
    inner += drawVectorFloor(vKey, fEst);
  } else if (plan && plan.file) {
    inner += `<image href="floorplans/${plan.file}" x="0" y="0" width="${vbW}" height="${vbH}"/>`;
  } else if (plan && plan.synthetic) {
    inner += drawSyntheticG1F();
  } else {
    inner += drawFloorPlanBackground(shownFloor);
  }

  // 마커·경로 크기: 벡터 층에서는 "화면 고정 크기"(사람은 작게, 매장은 확대돼도 사람 그대로)
  const mk = vSpec ? 14 / (26 * fEst) : k;   // 마커 반지름 ≈ 화면 14px 고정

  // 목적지 매장 칸 강조 (주황 카드) — 벡터 층 + 목적지 층
  if (vSpec && destStore && destStore._cellRef && onFloorDest) {
    const c = destStore._cellRef;
    inner += `<rect x="${(c.x - c.w / 2 - 0.5).toFixed(1)}" y="${(c.y - c.h / 2 - 0.5).toFixed(1)}"
      width="${(c.w + 1).toFixed(1)}" height="${(c.h + 1).toFixed(1)}" rx="1.4"
      fill="#fdeadb" stroke="#e8731a" stroke-width="${Math.max(0.4, 2.4 * mk)}"/>`;
  }

  // 차량 내비식 세분화: 내 주변 매대 칸에 호수 라벨 — 벡터 층 + 현재 층일 때만.
  // 라벨은 .lbl 이라 지도가 회전해도 똑바로 선다. (renderMap 은 위치 변경마다 재실행 → 따라옴)
  if (vSpec && onFloorCurrent) {
    // 매장명 라벨: 화면 고정 크기(≈11px), 내 주변 칸만
    const cfs = Math.min(2.2, 11 / fEst);
    (CELLS[vKey] || []).forEach((c) => {
      // 칸이 너무 작으면(촘촘한 열) 라벨 생략 — 겹쳐서 오히려 안 읽힘
      if (c.h < 2.6 || dist(currentLoc, c) > 75) return;
      const t = c.nm || c.no;
      if (!t) return;
      inner += `<text class="lbl" data-x="${c.x}" data-y="${c.y}" x="${c.x}" y="${c.y + cfs * 0.36}"
        font-size="${cfs}" fill="#5f6f62" text-anchor="middle" font-weight="700">${t}</text>`;
    });
  }
  const esc = plan && plan.escalator ? { x: plan.escalator[0], y: plan.escalator[1] } : null;
  if (destXY && onFloorCurrent && onFloorDest) {
    // 같은 층: 현재위치 → 목적지
    inner += routeVia(currentLoc, destXY, plan, mk);
  } else if (destXY && onFloorCurrent && !onFloorDest && esc) {
    // 층간 1단계: 현재위치 → 에스컬레이터
    // (QR이 에스컬레이터 바로 앞이면 마커·라벨이 현재위치와 겹치므로 생략)
    inner += routeVia(currentLoc, esc, plan, mk);
    if (dist(currentLoc, esc) > arriveR(plan) * 0.8) {
      inner += marker(esc.x, esc.y, "#7b5cc4", "에스컬레이터", "🛗", mk);
    }
  } else if (destXY && !onFloorCurrent && onFloorDest && esc) {
    // 층간 2단계: 에스컬레이터 → 목적지
    inner += routeVia(esc, destXY, plan, mk);
    inner += marker(esc.x, esc.y, "#7b5cc4", "에스컬레이터", "🛗", mk);
  }
  if (onFloorCurrent) {
    inner += headingCone(currentLoc.x, currentLoc.y, mk);
    inner += mePuck(currentLoc.x, currentLoc.y, mk);
  }
  if (onFloorDest && destXY) {
    inner += marker(destXY.x, destXY.y, "#e8731a", destStore.name, "★", mk);
  }
  if (DEBUG) inner += debugGrid(vbW, vbH);

  svg.innerHTML = inner;

  layoutMap();          // 지도 배치·회전
  applyHeading();       // 헤딩 콘 회전
  updateGuidance(lastGuideKey === null);   // 행동 지시 카드 (안내 시작 직후엔 무발화 — selectStore 인사와 중복 방지)
}

// 차량 내비식 지도 배치.
// 현재 위치 층: 내 위치를 화면 하단 중앙에 고정·확대(잘림 허용)하고 지도를 -heading 회전
//   — 내가 돌면 지도가 반대로 돌아 내 정면이 항상 화면 위 (내 시선은 화면에 고정).
// 다른 층 열람: 전체가 보이는 letterbox. 화면·지도 비율이 크게 어긋나면 90° 돌려 크게.
// 어느 모드든 마커 라벨(.lbl)은 역회전해 글자를 똑바로 유지한다.
// 현재 층 확대 배율 하한. 벡터 지도 층은 차량 내비처럼 근거리만(≈13m 시야) —
// 매대 칸이 카드 크기로 보이는 근접 뷰. PNG 층은 확대하면 흐려져서 낮게 유지.
function followScale() {
  return FLOOR_SPECS[`${shownDong}|${floorCode(shownFloor)}`] ? 16 : 1.35;
}
function layoutMap() {
  if (document.getElementById("stepNav").classList.contains("hidden")) return;   // 숨김 중 rAF 루프 방지
  const stage = document.getElementById("mapStage");
  const svg = document.getElementById("mapSvg");
  const plan = planFor(shownDong, shownFloor);
  const vbW = plan ? plan.w : 1000;
  const vbH = plan ? plan.h : 1000;
  const vw = stage.clientWidth, vh = stage.clientHeight;
  if (!vw || !vh) { requestAnimationFrame(layoutMap); return; }   // 숨김 상태면 재시도
  const fitN = Math.min(vw / vbW, vh / vbH);   // 전체가 보이는 letterbox 배율
  const onFloor = viewOf(currentLoc.building, currentLoc.floor) === `${shownDong}|${shownFloor}`;
  svg.style.position = "absolute";

  let deg;   // 지도의 화면 회전각
  if (MAP_MODE === "overview") {
    // 전체 지도 모드: 층 전체 보기(회전 없음) + 핀치줌·팬 (setupMapGestures 가 OV 갱신)
    const f = fitN * OV.z;
    svg.style.width = vbW * f + "px";
    svg.style.height = vbH * f + "px";
    const maxX = Math.max(0, (vbW * f - vw) / 2) + 60;   // 팬 한계 (지도가 화면을 아예 벗어나지 않게)
    const maxY = Math.max(0, (vbH * f - vh) / 2) + 60;
    OV.x = Math.max(-maxX, Math.min(maxX, OV.x));
    OV.y = Math.max(-maxY, Math.min(maxY, OV.y));
    svg.style.left = (vw - vbW * f) / 2 + OV.x + "px";
    svg.style.top = (vh - vbH * f) / 2 + OV.y + "px";
    svg.style.transformOrigin = "center";
    deg = 0;
  } else if (onFloor) {
    const f = Math.max(fitN, followScale());
    svg.style.width = vbW * f + "px";
    svg.style.height = vbH * f + "px";
    const px = currentLoc.x * f, py = currentLoc.y * f;
    const ax = vw / 2, ay = vh * 0.62;   // 내 위치 고정점(하단 중앙쪽 — 진행 방향이 넓게 보이게)
    svg.style.left = ax - px + "px";
    svg.style.top = ay - py + "px";
    svg.style.transformOrigin = `${px}px ${py}px`;
    deg = -activeHeading();
  } else {
    const fitR = Math.min(vw / vbH, vh / vbW);   // 90° 돌려 맞출 때 배율
    const rot = fitR > fitN * 1.2;               // 20% 이상 커질 때만 회전
    const f = rot ? fitR : fitN;
    svg.style.width = vbW * f + "px";
    svg.style.height = vbH * f + "px";
    svg.style.left = (vw - vbW * f) / 2 + "px";
    svg.style.top = (vh - vbH * f) / 2 + "px";
    svg.style.transformOrigin = "center";
    // 기준점(에스컬레이터 = 이 층 경로의 출발점)이 화면 아래쪽에 오는 방향으로
    const refX = plan && plan.escalator ? plan.escalator[0] : vbW / 2;
    deg = rot ? (refX < vbW / 2 ? -90 : 90) : 0;
  }
  svg.style.transform = deg ? `rotate(${deg}deg)` : "";
  // 라벨 보정: ① -deg 역회전(글자 똑바로) ② 2.5D 기울임의 세로 압축 보정(1/cos46°) — 빌보드 효과
  const K = document.getElementById("mapStage").classList.contains("tilted") ? 1.44 : 1;
  document.querySelectorAll("#mapSvg .lbl").forEach((el) => {
    const x = el.dataset.x, y = el.dataset.y;
    let t = deg ? `rotate(${-deg} ${x} ${y})` : "";
    if (K !== 1) t += ` translate(0 ${((1 - K) * y).toFixed(1)}) scale(1 ${K})`;
    el.setAttribute("transform", t.trim());
  });
}

// 재렌더 없이 방향 요소만 갱신: 지도 회전(layoutMap) + 헤딩 콘.
// 콘은 지도 좌표계에서 +H 회전 → 지도가 -H 돌므로 화면에선 항상 위를 가리킨다.
// (지시 갱신은 호출부가 담당 — renderMap은 silent 가드로, 나침반 경로는 onOrientation에서.)
function applyHeading() {
  if (document.getElementById("stepNav").classList.contains("hidden")) return;   // 네비 화면에서만
  const H = activeHeading();
  const cone = document.getElementById("headCone");
  if (cone) cone.setAttribute("transform", `rotate(${H} ${currentLoc.x} ${currentLoc.y})`);
  // 내 위치 퍽의 방향 삼각형도 같은 방위로 회전 (바라보는 방향 표시)
  const tri = document.getElementById("headTri");
  if (tri) tri.setAttribute("transform", `rotate(${H} ${currentLoc.x} ${currentLoc.y})`);
  layoutMap();
}

// 헤딩 콘: 현재위치 마커 아래에 깔리는 부채꼴(사용자가 보는 방향).
function headingCone(x, y, k) {
  const r = 130 * k;
  const a = (26 * Math.PI) / 180;   // 반각 26°
  const x1 = x - r * Math.sin(a), y1 = y - r * Math.cos(a);
  const x2 = x + r * Math.sin(a), y2 = y - r * Math.cos(a);
  return `<g id="headCone">
    <path d="M ${x} ${y} L ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2} Z"
          fill="#1e7a3c" opacity="0.26"/>
  </g>`;
}

// 판매동 1층 약식 평면도 (공식 평면도 미제공 층 — 직접 그린 배경, 좌표계 800x370)
// 수산(좌)·건해(중)·축산(우) 3개 부류 구역 + 하단 통로 + 에스컬레이터 + 출입구.
function drawSyntheticG1F() {
  let s = "";
  s += `<rect x="0" y="0" width="800" height="370" fill="#fdfcf9"/>`;
  s += `<rect x="40" y="52" width="720" height="256" rx="14" fill="#ffffff" stroke="#cfd8cf" stroke-width="3"/>`;
  // 구역 블록
  const blocks = [
    [70, 80, 230, 125, "#ddeef7", "#a9cbe0", "수산부류", "#3f7693"],
    [330, 80, 190, 125, "#f2ecd9", "#dcd0a8", "건해부류", "#8a7a45"],
    [550, 80, 190, 125, "#f9e4e0", "#e6bfb8", "축산부류", "#a05b52"],
  ];
  blocks.forEach(([x, y, w, h, fill, stroke, name, tc]) => {
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
    s += `<text x="${x + w / 2}" y="${y + h / 2 + 9}" font-size="26" fill="${tc}" text-anchor="middle" font-weight="700">${name}</text>`;
  });
  // 하단 통로
  s += `<line x1="60" y1="250" x2="742" y2="236" stroke="#cdd6cd" stroke-width="12" stroke-dasharray="2 16" stroke-linecap="round"/>`;
  // 에스컬레이터 (지하1층·3층과 같은 x≈240 위치)
  s += `<rect x="222" y="200" width="36" height="36" rx="8" fill="#e8a33d"/>`;
  s += `<text x="240" y="226" font-size="22" fill="#fff" text-anchor="middle" font-weight="700">↕</text>`;
  s += `<text x="240" y="196" font-size="15" fill="#b07818" text-anchor="middle" font-weight="700">에스컬레이터</text>`;
  // 출입구 표시
  s += `<text x="92" y="288" font-size="16" fill="#9aa89a" font-weight="700">◀ 서측 입구</text>`;
  s += `<text x="710" y="278" font-size="16" fill="#9aa89a" text-anchor="end" font-weight="700">동측 입구 ▶</text>`;
  return s;
}

// ═══ 벡터 층 엔진: 호수 기반 매장 배치 + 벡터 지도 + 보행 격자 ═══
// FLOOR_SPECS 에 층 명세(외곽·통로·시설·매대 구획)를 추가하면 그 층은
// ① 매장별 좌표 자동 배치(호수 규칙) ② 벡터 지도 ③ A* 보행 경로가 전부 적용된다.
// ⚠️ 구획 위치·열 순서는 도면 기반 추정 — 현장/카카오맵 대조로 확정 후 수치만 수정.

const B1_TOPY = (x) => 84 - 0.0343 * (x - 28);   // 판매동 상단 외벽 y (B1 기준)
const B1_CORY = (x) => 235 - 0.176 * (x - 65);   // B1 통로 중심선
const B1_BOTY = (x) => 225 - 0.203 * (x - 310);  // B1 남측 외벽 (x≥315 동쪽 구간)
const F1_CORY = (x) => 250 - 0.0207 * (x - 65);  // 1층 통로
const G3_CORY = (x) => 140 + 0.0441 * (x - 95);  // 3층 통로
const B2_CORY = (x) => 620 - 0.217 * (x - 130);  // B2 통로

// B1 매대 밴드: 통로 북측(항상) + 통로 남측(동쪽 구간)
function b1Bands(x) {
  const bands = [[B1_TOPY(x) + 20, B1_CORY(x) - 14]];
  if (x >= 315) {
    const s0 = B1_CORY(x) + 12, s1 = B1_BOTY(x) - 5;
    if (s1 - s0 > 8) bands.push([s0, s1]);
  }
  return bands;
}

const FLOOR_SPECS = {
  // ── 판매동 지하1층: 청과·채소 (호수 A~H열 규칙) ──
  "G|B1": {
    building: "가락몰 판매동", w: 800, h: 370,
    poly: [[28, 84], [786, 58], [788, 128], [310, 225], [300, 292], [84, 292], [62, 246], [28, 246]],
    corridor: [[65, 235], [160, 245], [280, 235], [420, 205], [560, 175], [680, 140], [745, 115]],
    connectors: [[240, 150, 240, 204]],
    blocks: [
      [36, 168, 74, 70, "#dde9f0", "#b9cfdd", "#a4bfd0", "편의시설", "#3f6b85"],
      [150, 232, 148, 52, "#fbf0dc", "#e8d9b8", "#d3bf8e", "식품·식자재", "#9a7f42"],
    ],
    esc: [240, 135],
    evs: [[350, 92], [520, 84], [660, 78]],
    wcs: [[300, 186], [757, 96]],
    notes: [[84, 262, "◀ 서측 입구"], [742, 96, "동측 ▶"]],
    title: [460, 60, "채소·과일", "#3e6b4c"],
    stalls: [{
      section: "청과부류", re: /^([A-H])(\d+)/, segs: [[130, 196], [284, 740]],
      bands: b1Bands, colW: 6, aisleW: 6,
      cellFill: "#eef4e8", cellStroke: "#c2d7c4", chipC: "#3e6b4c",
    }],
  },
  // ── 판매동 1층: 수산·건해·축산 (구역별 순번 호수) ──
  "G|1F": {
    building: "가락몰 판매동", w: 800, h: 370,
    poly: [[40, 52], [760, 52], [760, 308], [40, 308]],
    corridor: [[60, 250], [742, 236]],
    connectors: [[240, 232, 240, 250]],
    blocks: [],
    esc: [240, 218],
    evs: [[420, 62], [660, 62]],
    wcs: [[110, 66], [700, 250]],
    notes: [[92, 292, "◀ 서측 입구"], [710, 282, "동측 입구 ▶"]],
    title: null,
    stalls: [
      { section: "수산부류", re: null, chip: "수산", segs: [[70, 212], [268, 302]],
        bands: (x) => [[92, F1_CORY(x) - 16]], colW: 6, aisleW: 6,
        cellFill: "#e9f4fa", cellStroke: "#b8d4e4", chipC: "#3f7693" },
      { section: "건해부류", re: null, chip: "건해", segs: [[330, 520]],
        bands: (x) => [[92, F1_CORY(x) - 16]], colW: 6, aisleW: 6,
        cellFill: "#f7f2e3", cellStroke: "#d8cda6", chipC: "#8a7a45" },
      { section: "축산부류", re: null, chip: "축산", segs: [[550, 740]],
        bands: (x) => [[92, F1_CORY(x) - 16]], colW: 6, aisleW: 6,
        cellFill: "#fbece9", cellStroke: "#e2c2ba", chipC: "#a05b52" },
    ],
  },
  // ── 판매동 3층: 관련상가·부대시설 (구역별 순번 호수) ──
  "G|3F": {
    building: "가락몰 판매동", w: 800, h: 370,
    poly: [[60, 80], [740, 80], [740, 290], [60, 290]],
    corridor: [[95, 140], [230, 160], [380, 172], [520, 168], [650, 168], [730, 168]],
    connectors: [],
    blocks: [],
    esc: [570, 148],
    evs: [[350, 92], [660, 92]],
    wcs: [[120, 270], [700, 270]],
    notes: [],
    title: [400, 70, "식당가·상가", "#8a7a45"],
    stalls: [
      { section: "관련상가", re: null, chip: "상가", segs: [[80, 450]],
        bands: (x) => [[G3_CORY(x) + 14, 272]], colW: 8, aisleW: 7,
        cellFill: "#f4ede0", cellStroke: "#d8cdb2", chipC: "#8a7a45" },
      { section: "부대시설", re: null, chip: "부대", segs: [[480, 736]],
        bands: (x) => [[G3_CORY(x) + 14, 272]], colW: 8, aisleW: 7,
        cellFill: "#ece9f2", cellStroke: "#c9c2dc", chipC: "#6a5f8f" },
    ],
  },
  // ── 판매동 지하2층: 냉동창고(부대시설 A~E) + 축산 A구역 ──
  "G|B2": {
    building: "가락몰 판매동", w: 1100, h: 960,
    poly: [[57, 318], [985, 318], [1040, 378], [1040, 412], [988, 448], [95, 668], [62, 640]],
    corridor: [[130, 620], [280, 598], [480, 545], [660, 505]],
    connectors: [[285, 500, 285, 592]],
    blocks: [],
    esc: [285, 477],
    evs: [[150, 400], [430, 400], [790, 430]],
    wcs: [[475, 585], [790, 470]],
    notes: [[130, 655, "◀ 서측"], [990, 465, "동측 ▶"]],
    title: [520, 292, "냉동창고", "#8a7a45"],
    stalls: [
      { section: "부대시설", re: /^([A-E])(\d+)/, segs: [[95, 585]],
        bands: (x) => [[370, Math.min(560, B2_CORY(x) - 18)]], colW: 11, aisleW: 8,
        cellFill: "#f4efe2", cellStroke: "#d8cfb6", chipC: "#8a7a45" },
      { section: "축산부류", re: null, chip: "축산", segs: [[618, 712]],
        bands: () => [[355, 425]], colW: 11, aisleW: 8,
        cellFill: "#fbece9", cellStroke: "#e2c2ba", chipC: "#a05b52" },
    ],
  },
};

function fcToFloor(fc) { return fc.startsWith("B") ? -Number(fc.slice(1)) : parseInt(fc); }

let CELLS = {};   // key → [{x,y,w,h,no,fill,stroke}] 매대 칸 (매장 1 = 칸 1)
let NAVS = {};    // key → 보행 격자 {cs,W,H,blocked}

// ── 매장 → 자기 호수 자리 좌표 (전 벡터 층) ────────────────
// 수작업 좌표(x,y)가 이미 있으면 건드리지 않는다.
function assignStalls() {
  CELLS = {}; NAVS = {};
  let assigned = 0;
  for (const [key, spec] of Object.entries(FLOOR_SPECS)) {
    const floor = fcToFloor(key.split("|")[1]);
    CELLS[key] = [];
    spec.stalls.forEach((st) => {
      // u = 세그먼트(걸을 수 있는 x구간)를 이어붙인 연속좌표
      const segW = st.segs.map(([a, b]) => b - a);
      const uMax = segW.reduce((a, b) => a + b, 0);
      const uToX = (u) => {
        for (let i = 0; i < st.segs.length; i++) {
          if (u <= segW[i] || i === st.segs.length - 1) return st.segs[i][0] + Math.min(u, segW[i]);
          u -= segW[i];
        }
        return st.segs[0][0];
      };
      // 그룹: 호수 접두어(A~H 등) 또는 전체 1그룹
      const byG = {};
      STORES.forEach((s) => {
        if (s.building !== spec.building || s.section !== st.section || s.floor !== floor) return;
        let g = "", n = 0;
        if (st.re) {
          const m = st.re.exec(s.zone || "");
          if (!m) return;   // 규칙 밖 호수는 구역 대표좌표 폴백 유지
          g = m[1]; n = parseInt(m[2]);
        } else {
          n = parseInt((s.zone || "").match(/\d+/)?.[0] || "0");
        }
        (byG[g] = byG[g] || []).push({ s, n });
      });
      const letters = Object.keys(byG).sort();
      const total = letters.reduce((a, l) => a + byG[l].length, 0);
      if (!total) return;
      st._chips = [];
      let u0 = 0;
      letters.forEach((letter) => {
        const list = byG[letter].sort((a, b) => a.n - b.n || a.s.zone.localeCompare(b.s.zone));
        const u1 = u0 + (list.length / total) * uMax;
        // 열 생성: 매대 colW 2열마다 골목 aisleW
        const cols = [];
        let u = u0, ci = 0;
        while (u + st.colW <= u1) {
          const x = uToX(u + st.colW / 2);
          const bands = st.bands(x).filter(([a, b]) => b - a > 3);
          if (bands.length) cols.push({ x, bands, cap: bands.reduce((a, [y0, y1]) => a + (y1 - y0), 0) });
          u += st.colW;
          if (++ci % 2 === 0) u += st.aisleW;
        }
        if (!cols.length) {
          const x = uToX((u0 + u1) / 2);
          const bands = st.bands(x).filter(([a, b]) => b - a > 3);
          if (bands.length) cols.push({ x, bands, cap: bands.reduce((a, [y0, y1]) => a + (y1 - y0), 0) });
        }
        const capSum = cols.reduce((a, c) => a + c.cap, 0) || 1;
        let idx = 0;
        cols.forEach((c, cI) => {
          const take = cI === cols.length - 1
            ? list.length - idx
            : Math.min(list.length - idx, Math.round(list.length * (c.cap / capSum)));
          if (take <= 0) return;
          const cellH = c.cap / take;
          for (let r = 0; r < take; r++, idx++) {
            let cum = (r + 0.5) * cellH, y = null;
            for (const [b0, b1] of c.bands) {
              if (cum <= b1 - b0) { y = b0 + cum; break; }
              cum -= b1 - b0;
            }
            if (y == null) y = c.bands[c.bands.length - 1][1] - cellH / 2;
            const o = list[idx];
            const no = st.re ? letter + o.n : String((o.s.zone || "").match(/\d+/)?.[0] || "");
            // 칸 라벨용 짧은 매장명 (법인 접두어 제거, 6자 제한)
            const nm = (o.s.name || "").replace(/^\((유|주)\)|^유한회사\s*|^주식회사\s*/, "").slice(0, 6);
            CELLS[key].push({ x: c.x, y, w: st.colW - 1.4, h: Math.max(2.5, cellH - 1.4),
                              no, nm, fill: st.cellFill, stroke: st.cellStroke });
            if (Number.isFinite(o.s.x) && Number.isFinite(o.s.y)) continue;   // 수작업 좌표 보존
            o.s.x = Math.round(c.x * 10) / 10;
            o.s.y = Math.round(y * 10) / 10;
            o.s._zoneCalc = true;   // 호수 규칙 기반 추정 좌표 (파일에는 저장 안 됨)
            o.s._cellRef = CELLS[key][CELLS[key].length - 1];   // 목적지 칸 강조용
            assigned++;
          }
        });
        // 그룹 이름표 (문자 열 = 문자, 단일 그룹 = 구역 축약명)
        const cx = uToX((u0 + u1) / 2);
        const band0 = st.bands(cx)[0];
        if (band0) st._chips.push({ x: cx, y: (band0[0] + band0[1]) / 2, t: letter || st.chip || "", c: st.chipC });
        u0 = u1;
      });
    });
    buildNav(key, spec);
  }
  if (DEBUG) console.log(`[stalls] 좌표 배정 ${assigned}개, 층: ${Object.keys(CELLS).join(", ")}`);
}

// ── 보행 격자 + A* (매대·시설을 뚫지 않는 실보행 경로) ─────
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function buildNav(key, spec) {
  const cs = 4;   // 격자 셀 ≈ 1.2m
  const W = Math.ceil(spec.w / cs), H = Math.ceil(spec.h / cs);
  const blocked = new Uint8Array(W * H);
  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W; gx++) {
      const x = (gx + 0.5) * cs, y = (gy + 0.5) * cs;
      let b = pointInPoly(x, y, spec.poly) ? 0 : 1;
      if (!b) {
        for (const [bx, by, bw, bh] of spec.blocks) {
          if (x > bx && x < bx + bw && y > by && y < by + bh) { b = 1; break; }
        }
      }
      blocked[gy * W + gx] = b;
    }
  }
  CELLS[key].forEach((c) => {
    const x0 = Math.max(0, Math.floor((c.x - c.w / 2 - 0.4) / cs));
    const x1 = Math.min(W - 1, Math.floor((c.x + c.w / 2 + 0.4) / cs));
    const y0 = Math.max(0, Math.floor((c.y - c.h / 2 - 0.4) / cs));
    const y1 = Math.min(H - 1, Math.floor((c.y + c.h / 2 + 0.4) / cs));
    for (let gy = y0; gy <= y1; gy++)
      for (let gx = x0; gx <= x1; gx++) blocked[gy * W + gx] = 1;
  });
  NAVS[key] = { cs, W, H, blocked };
}

function navSnap(nav, gx, gy) {
  const { W, H, blocked } = nav;
  if (gx >= 0 && gy >= 0 && gx < W && gy < H && !blocked[gy * W + gx]) return [gx, gy];
  for (let r = 1; r <= 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = gx + dx, ny = gy + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && !blocked[ny * W + nx]) return [nx, ny];
      }
    }
  }
  return null;
}

function navLos(nav, ax, ay, bx, by) {
  const { cs, W, blocked } = nav;
  const d = Math.hypot(bx - ax, by - ay);
  const n = Math.max(2, Math.ceil(d / (cs * 0.5)));
  for (let i = 0; i <= n; i++) {
    const x = ax + ((bx - ax) * i) / n, y = ay + ((by - ay) * i) / n;
    if (blocked[Math.floor(y / cs) * W + Math.floor(x / cs)]) return false;
  }
  return true;
}

// A*(8방향, 모서리 끼임 방지) → LOS 스무딩 → [[x,y],...]
function navRoute(from, to, key) {
  const nav = NAVS[key];
  if (!nav) return null;
  const { cs, W, H, blocked } = nav;
  const s = navSnap(nav, Math.floor(from.x / cs), Math.floor(from.y / cs));
  const g = navSnap(nav, Math.floor(to.x / cs), Math.floor(to.y / cs));
  if (!s || !g) return null;
  const idx = (x, y) => y * W + x;
  const open = [[0, s[0], s[1]]];
  const gCost = new Float32Array(W * H).fill(Infinity);
  const came = new Int32Array(W * H).fill(-1);
  gCost[idx(s[0], s[1])] = 0;
  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4], [1, -1, 1.4], [-1, 1, 1.4], [-1, -1, 1.4]];
  let found = false;
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, cx, cy] = open.splice(bi, 1)[0];
    if (cx === g[0] && cy === g[1]) { found = true; break; }
    for (const [dx, dy, w] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || blocked[idx(nx, ny)]) continue;
      if (dx && dy && (blocked[idx(cx + dx, cy)] || blocked[idx(cx, cy + dy)])) continue;
      const ng = gCost[idx(cx, cy)] + w;
      if (ng < gCost[idx(nx, ny)]) {
        gCost[idx(nx, ny)] = ng;
        came[idx(nx, ny)] = idx(cx, cy);
        open.push([ng + Math.hypot(g[0] - nx, g[1] - ny), nx, ny]);
      }
    }
  }
  if (!found) return null;
  const raw = [];
  let cur = idx(g[0], g[1]);
  while (cur !== -1) {
    raw.push([(cur % W + 0.5) * cs, (Math.floor(cur / W) + 0.5) * cs]);
    cur = came[cur];
  }
  raw.reverse();
  const pts = [[from.x, from.y]];
  let i = 0;
  const anchor = () => pts[pts.length - 1];
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1 && !navLos(nav, anchor()[0], anchor()[1], raw[j][0], raw[j][1])) j--;
    pts.push(raw[j]);
    i = j;
  }
  pts.push([to.x, to.y]);   // 마지막: 골목 → 매장 앞
  return pts;
}

// ── 벡터 층 지도 그리기 (spec 기반) ────────────────────────
// f = 현재 화면 배율. 라벨·아이콘은 sf()로 화면 고정 크기, 구조물은 물리 크기.
function drawVectorFloor(key, f = 1) {
  const spec = FLOOR_SPECS[key];
  if (!spec) return "";
  const sf = (px) => px / Math.max(0.3, f);
  const lbl = (x, y, t, fs, color, weight = 700) =>
    `<text class="lbl" data-x="${x}" data-y="${y}" x="${x}" y="${y}" font-size="${fs}"
       fill="${color}" text-anchor="middle" font-weight="${weight}">${t}</text>`;
  const block = (x, y, w, h, fill, stroke, side, depth = 6) =>
    `<rect x="${x}" y="${y + h - 2}" width="${w}" height="${depth + 2}" rx="4" fill="${side}"/>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;

  let s = "";
  s += `<rect x="0" y="0" width="${spec.w}" height="${spec.h}" fill="#efe9da"/>`;
  s += `<polygon points="${spec.poly.map((p) => p.join(",")).join(" ")}"
          fill="#f6f1e4" stroke="#ddd3ba" stroke-width="3"/>`;
  // 통로 (밝은 띠 + 점선 중심선)
  const corPath = "M " + spec.corridor.map(([x, y]) => `${x} ${y}`).join(" L ");
  s += `<path d="${corPath}" fill="none" stroke="#fdfaf2" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>`;
  s += `<path d="${corPath}" fill="none" stroke="#e2dbc9" stroke-width="2.5" stroke-dasharray="3 14" stroke-linecap="round"/>`;
  spec.connectors.forEach(([x1, y1, x2, y2]) => {
    s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fdfaf2" stroke-width="20"/>`;
  });
  // 정적 블록 (편의시설 등)
  spec.blocks.forEach(([x, y, w, h, fill, stroke, side, label, lc]) => {
    s += block(x, y, w, h, fill, stroke, side);
    if (label) s += lbl(x + w / 2, y + h / 2 + 3, label, sf(10), lc);
  });
  // 매대 칸 (매장 1 = 칸 1)
  (CELLS[key] || []).forEach((c) => {
    s += `<rect x="${(c.x - c.w / 2).toFixed(1)}" y="${(c.y - c.h / 2).toFixed(1)}" width="${c.w}" height="${c.h.toFixed(1)}" rx="1.2" fill="${c.fill}" stroke="${c.stroke}" stroke-width="0.5"/>`;
  });
  // 그룹 이름표
  spec.stalls.forEach((st) => (st._chips || []).forEach((ch) => {
    s += `<g class="lbl" data-x="${ch.x}" data-y="${ch.y}">
      <circle cx="${ch.x}" cy="${ch.y}" r="${sf(11)}" fill="#ffffff" opacity="0.85"/>
      <text x="${ch.x}" y="${ch.y + sf(4.5)}" font-size="${sf(ch.t.length > 1 ? 9 : 13)}" fill="${ch.c}" text-anchor="middle" font-weight="800">${ch.t}</text>
    </g>`;
  }));
  if (spec.title && f < 3) s += lbl(spec.title[0], spec.title[1], spec.title[2], sf(11), spec.title[3], 800);
  // 에스컬레이터 (실물 크기 ≈4m)
  if (spec.esc) {
    const [ex, ey] = spec.esc;
    s += `<rect x="${ex - 7}" y="${ey - 7}" width="14" height="14" rx="3" fill="#e8a33d"/>`;
    s += lbl(ex, ey + 2.5, "↕", sf(9), "#fff");
    s += lbl(ex, ey + sf(16), "에스컬레이터", sf(9), "#b07818");
  }
  spec.evs.forEach(([x, y]) => {
    s += `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" rx="2" fill="#6f8fbf"/>`;
    s += lbl(x, y + sf(3.5), "EV", sf(8), "#fff");
  });
  spec.wcs.forEach(([x, y]) => { s += lbl(x, y, "🚻", sf(11), "#5b7ea8"); });
  spec.notes.forEach(([x, y, t]) => { s += lbl(x, y, t, sf(10), "#7d8877"); });
  return s;
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

// 경로 좌표 계산: from → (통로 진입) → 통로 중심선 따라 이동 → (통로 이탈) → to
// corridor 가 없으면 ㄱ자 꺾은선 폴백.
function computeRoutePts(from, to, plan) {
  // 벡터 층: 보행 격자 A* — 매대·시설을 뚫지 않는 실제 걸을 수 있는 경로
  if (plan) {
    const key = `${plan.dong}|${plan.floorCode}`;
    if (NAVS[key]) {
      const p = navRoute(from, to, key);
      if (p) return p;
    }
  }
  const corridor = plan && plan.corridor;
  if (corridor && corridor.length >= 2) {
    const pa = projectOnCorridor(from, corridor);
    const pb = projectOnCorridor(to, corridor);
    const mid = [];
    if (pa.seg <= pb.seg) {
      for (let i = pa.seg + 1; i <= pb.seg; i++) mid.push(corridor[i]);
    } else {
      for (let i = pa.seg; i > pb.seg; i--) mid.push(corridor[i]);
    }
    return [[from.x, from.y], [pa.x, pa.y], ...mid, [pb.x, pb.y], [to.x, to.y]];
  }
  return [[from.x, from.y], [from.x, to.y], [to.x, to.y]];   // ㄱ자 폴백
}

// 경로 SVG (2D 지도용)
function routeVia(from, to, plan, k) {
  const pts = computeRoutePts(from, to, plan);
  const d = "M " + pts.map(([x, y]) => `${Math.round(x)} ${Math.round(y)}`).join(" L ");
  // k 는 화면 배율 역보정값일 수 있어(벡터 층 근접 뷰) 최소 클램프를 두지 않는다
  const w = 11 * k;
  // 차량 내비식 도로 표현: 흰 외곽선 → 주황 도로 → 흐르는 밝은 대시(진행감)
  return `
    <path d="${d}" fill="none" stroke="#ffffff" stroke-width="${w * 1.9}"
          stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
    <path d="${d}" fill="none" stroke="#e8731a" stroke-width="${w * 1.25}"
          stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="#ffd9b0" stroke-width="${w * 0.45}"
          stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${16 * k} ${22 * k}">
      <animate attributeName="stroke-dashoffset" from="${38 * k}" to="0" dur="0.7s" repeatCount="indefinite"/>
    </path>`;
}

// 내 위치 퍽: 은은한 글로우 + 초록 원 + 바라보는 방향 삼각형(헤딩 따라 회전) + 라벨
function mePuck(x, y, k) {
  const r = 24 * k;
  const fs = 22 * k;
  const lw = 4 * fs * 0.95 + 16 * k;
  return `
    <g>
      <circle cx="${x}" cy="${y}" r="${r * 1.8}" fill="#1e7a3c" opacity="0.14"/>
      <circle cx="${x}" cy="${y}" r="${r}" fill="#1e7a3c" stroke="#fff" stroke-width="${5 * k}"/>
      <g id="headTri">
        <polygon points="${x},${y - r * 0.52} ${x - r * 0.42},${y + r * 0.36} ${x + r * 0.42},${y + r * 0.36}" fill="#fff"/>
      </g>
      <g class="lbl" data-x="${x}" data-y="${y}">
        <rect x="${x - lw / 2}" y="${y + r + 4 * k}" width="${lw}" height="${fs * 1.7}" rx="${8 * k}" fill="#1e7a3c" opacity="0.95"/>
        <text x="${x}" y="${y + r + 4 * k + fs * 1.2}" font-size="${fs}" fill="#fff" text-anchor="middle" font-weight="700">현재위치</text>
      </g>
    </g>`;
}

// 마커: 원 + 아이콘 + 라벨
// k 는 화면 배율 역보정값일 수 있어(벡터 층 근접 뷰) 최소 클램프를 두지 않는다
function marker(x, y, color, label, glyph, k) {
  const r = 24 * k;
  const fs = 22 * k;
  const lw = label.length * fs * 0.95 + 16 * k;
  return `
    <g>
      <circle cx="${x}" cy="${y}" r="${r}" fill="${color}" stroke="#fff" stroke-width="${5 * k}"/>
      <text class="lbl" data-x="${x}" data-y="${y}" x="${x}" y="${y + fs * 0.36}" font-size="${fs}" fill="#fff" text-anchor="middle" font-weight="700">${glyph}</text>
      <g class="lbl" data-x="${x}" data-y="${y}">
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

  // 보안 컨텍스트 확인: 음성인식은 HTTPS(또는 localhost)에서만 동작.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const secure = window.isSecureContext;   // https/localhost = true
  if (!SR || !secure) {
    // 음성 미지원 환경(http 접속 등): 평소엔 안내문 없이 조용히 두고,
    // 마이크를 눌렀을 때만 짧게 알려준다 (버튼 입력은 그대로 사용 가능)
    btn.addEventListener("click", () => {
      statusEl.textContent = "지금은 음성이 안 돼요. 아래 버튼을 눌러주세요.";
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
