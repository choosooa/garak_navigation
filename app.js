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
let ZONE_BY_KEY = {};   // 구역 대표좌표 맵: "building|floor" → {x,y,mapped}
let PLANS = [];         // 평면도 인덱스 (floorplans/index.json)
let PLAN_BY_KEY = {};   // "동코드|층코드" → plan 항목 (예: "G|B1")
let currentLoc = null;  // 현재 위치(QR) 객체
let destStore = null;   // 안내 중인 목적지 매장 (3단계에서만 설정)
let candidates = [];    // 2단계 후보 매장 목록 [{s, xy, r}]
let lastQuery = "";     // 마지막 검색어(가게 선택 화면 문구용)
let shownDong = null;   // 지도에 표시 중인 동코드(A~G)
let shownFloor = 1;     // 지도에 표시 중인 층

// 방향 정렬 상태 — 지도는 북쪽 고정, 헤딩 콘/HUD 화살표만 회전
let USER_HEADING = null;   // 실시간 나침반 방위(0~360) — 없으면 null(QR 고정값 폴백)
let COMPASS_ON = false;    // 나침반 리스너 부착 여부(중복 부착 방지)
let rafPending = false;    // applyHeading rAF 예약 중복 방지

let VOICE_GUIDE = true;    // 음성 안내(TTS) 켜짐 여부 — 고령 사용자 배려 기본 ON
let NAV_MODE = "3d";       // 지도 표시 모드: "3d"(1인칭 주행 시점, 기본) | "2d"(전체 지도)

// 걸음 감지 이동(PDR: 보행자 추측항법) 상태
let TRACKING = true;       // 따라가기 켜짐 (센서 없으면 자동으로 QR 고정 위치 동작)
let MOTION_ON = false;     // devicemotion 리스너 부착 여부
let stepRising = false;    // 가속도 피크 감지용 상태
let accLP = 0;             // 가속도 크기 저역 필터값
let lastStepT = 0;         // 마지막 걸음 시각(중복 방지)
let lastGuideKey = null;   // 행동 지시 상태 키 — 바뀔 때만 TTS 발화 (거리 숫자 변화로는 발화 안 함)
let NAV_BASE = null;       // { bearing: 안내 시작 시 경로 방향, compass0: 그때의 나침반값 } — 상대 회전 기준
let stepRafPending = false;
const STEP_METERS = 0.7;   // 한 걸음 보폭(성인 평균 근사)
const STEP_MIN_MS = 350;   // 걸음 최소 간격

const CANDIDATE_MAX = 8;   // 가게 선택 목록 최대 표시 수 (너무 길면 고령 사용자에게 부담)
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
function viewOf(building, floor) { return `${dongOf(building)}|${floor}`; }

// 도착 판정 거리: 평면도 층은 픽셀좌표라 층 크기에 비례시킨다
function arriveR(plan) { return plan ? Math.min(plan.w, plan.h) * 0.11 : 40; }

// 픽셀 거리 → 대략적인 미터 (평면도 축척 mpp 가 있을 때만, 5m 단위 반올림)
function approxMeters(px, plan) {
  if (!plan || !plan.mpp) return null;
  return Math.max(5, Math.round((px * plan.mpp) / 5) * 5);
}

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

// "가락몰 판매동 청과부류" → "판매동" 같이 화면용 짧은 건물명
function shortBuilding(b) {
  return b.replace(/^가락몰\s*/, "").split(" ")[0] || b;
}

// 카테고리 버튼 정의: { label(화면표시), emoji, terms(검색에 쓸 동의어들) }
// 음성으로 "과일/마늘/건어물"을 말해도 매칭되도록 terms 에 동의어를 넣습니다.
const CATEGORIES = [
  { label: "청과·과일",   emoji: "🍎", terms: ["청과", "과일", "사과", "배", "귤", "포도", "딸기", "수박", "참외", "복숭아", "바나나"] },
  { label: "채소·나물",   emoji: "🥬", terms: ["채소", "마늘", "나물", "양파", "대파", "배추", "무", "상추", "고추", "버섯", "감자", "고구마"] },
  { label: "건어물·특산품", emoji: "🦑", terms: ["건어물", "팔도특산품", "특산품", "멸치", "김", "미역", "다시마", "견과"] },
  { label: "수산·생선",   emoji: "🐟", terms: ["수산", "생선", "회", "고등어", "갈치", "오징어", "새우", "조개", "게", "낙지"] },
  { label: "축산·정육",   emoji: "🥩", terms: ["축산", "정육", "고기", "한우", "소고기", "돼지고기", "삼겹살", "닭", "닭고기", "오리"] },
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
  setupNavButtons();          // 2·3단계 버튼(뒤로/처음/음성안내) 연결

  // 데모·테스트용 딥링크: ?go=과일 → 자동 검색, &pick=1 → N번째 가게로 바로 안내
  const params = new URLSearchParams(location.search);
  const goQ = params.get("go");
  if (goQ) {
    handleQuery(goQ);
    const pick = parseInt(params.get("pick"));
    if (pick && candidates[pick - 1]) selectStore(candidates[pick - 1].s);
  }
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

// ── 1단계: 입력 ────────────────────────────────────────────
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

// ── 2단계: 후보 검색 → 가게 선택 목록 ──────────────────────
// 입력어 → 취급 매장 필터 → 정렬(같은 층 → 정합 좌표 → 거리) → 상위 CANDIDATE_MAX곳 표시
function handleQuery(query) {
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
  speak(`${q} 파는 가게 ${matches.length}곳을 찾았어요. 갈 가게를 골라주세요.`);
}

// 입력 화면 안의 안내 문구(검색 실패 등)
function showInputNotice(msg) {
  const el = document.getElementById("voiceStatus");
  el.textContent = msg;
  speak(msg);
}

// 후보 카드 하나에 표시할 거리/층 안내 문구
function candidateMeta(o) {
  const sameView = viewOf(o.s.building, o.s.floor) === viewOf(currentLoc.building, currentLoc.floor);
  if (sameView) {
    const plan = planFor(dongOf(o.s.building), o.s.floor);
    const m = approxMeters(o.d, plan);
    return m ? `같은 층 · 약 ${m}m` : "같은 층";
  }
  const mapped = storeMapped(o.s) && planFor(dongOf(o.s.building), o.s.floor);
  return mapped
    ? `${floorLabel(o.s.floor)} · 에스컬레이터 이용`
    : `${shortBuilding(o.s.building)} ${floorLabel(o.s.floor)} · 위치 대략`;
}

function renderStoreList(totalCount) {
  const m = mascotFor(lastQuery);
  document.getElementById("selectMascot").src = m.img;
  document.getElementById("selectBubble").innerHTML =
    `<b>'${lastQuery}'</b> 파는 가게예요.<br />가고 싶은 곳을 눌러주세요!`;
  document.getElementById("selectHint").textContent =
    totalCount > candidates.length
      ? `가까운 순서로 ${candidates.length}곳을 보여드려요 (전체 ${totalCount}곳)`
      : `가까운 순서로 보여드려요`;

  const list = document.getElementById("storeList");
  list.innerHTML = "";
  candidates.forEach((o, i) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "store-card";
    card.innerHTML = `
      <span class="store-rank">${i + 1}</span>
      <span class="store-info">
        <strong>${o.s.name}</strong>
        <span class="store-where">${candidateMeta(o)} · ${o.s.zone}</span>
        <span class="store-tags">${o.s.categories.map((c) => `<em>${c}</em>`).join("")}</span>
      </span>
      <span class="store-go">안내<br />▶</span>`;
    card.addEventListener("click", () => { enableCompass(); selectStore(o.s); });
    list.appendChild(card);
  });
}

// ── 3단계: 네비게이션 ─────────────────────────────────────
function selectStore(store) {
  destStore = store;
  const xy = storeXY(store);
  const sameView = viewOf(store.building, store.floor) === viewOf(currentLoc.building, currentLoc.floor);

  // 지시 카드 목적지 줄 (세부 주소는 표시하지 않음 — 지도가 위치를 보여준다)
  document.getElementById("navDestName").textContent = `${store.name}까지`;

  // 걸음 추적 준비: 사용자 제스처(카드 탭) 안에서 센서 권한 확보 + 지시 상태 초기화
  lastGuideKey = null;
  enableMotion();

  // 지도: 새 안내는 항상 주행 시점부터. 층간이면 현재 층부터(에스컬레이터까지 1단계 안내)
  NAV_MODE = "3d";
  shownDong = dongOf(currentLoc.building);
  shownFloor = sameView ? store.floor : currentLoc.floor;
  renderFloorTabs();
  goStep("nav");    // 먼저 화면을 보이게 한 뒤 렌더 (숨김 상태에선 3D 배치 크기가 0으로 계산됨)
  renderMap();

  // 시야 기준 = 경로 진행 방향. 발밑 진입점이 아니라 경로를 따라 15m쯤 간 지점을 바라본다.
  // 나침반은 여기서부터 상대 회전 (몸을 돌린 만큼 시야가 돈다).
  let tgt = pointAlongRoute(30);
  if (tgt && Math.hypot(tgt.x - currentLoc.x, tgt.y - currentLoc.y) < 15) tgt = null;  // 왕복성 제자리 경로
  if (!tgt && NAV3D && NAV3D.plan && NAV3D.plan.corridor) {
    // 경로가 제자리 수준(이미 목적 지점)이면 통로 방향을 바라본다 (벽만 보는 화면 방지)
    const c = NAV3D.plan.corridor;
    const pr = projectOnCorridor(currentLoc, c);
    const nxt = c[Math.min(pr.seg + 1, c.length - 1)];
    tgt = { x: nxt[0], y: nxt[1] };
    if (Math.hypot(tgt.x - currentLoc.x, tgt.y - currentLoc.y) < 6) tgt = null;
  }
  if (tgt) {
    NAV_BASE = { bearing: bearingTo(currentLoc, tgt), compass0: USER_HEADING };
    applyHeading();
  }

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
    NAV_BASE = null;
    goStep("select");
  });
  document.getElementById("restartBtn").addEventListener("click", () => {
    destStore = null;
    NAV_BASE = null;
    candidates = [];
    document.getElementById("voiceStatus").textContent = "";
    goStep("input");
  });
  // 걸음 따라가기 토글 (센서 없는 환경에선 QR 고정 위치로 자연 폴백)
  const trackBtn = document.getElementById("trackBtn");
  trackBtn.addEventListener("click", () => {
    TRACKING = !TRACKING;
    trackBtn.classList.toggle("off", !TRACKING);
    if (TRACKING) {
      enableMotion();   // 사용자 제스처 안에서 권한 요청(iOS)
      speak("걸음 따라가기를 켰어요. 걸으면 지도가 함께 움직여요.");
    } else {
      speak("걸음 따라가기를 껐어요.");
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

  // 주행 시점 / 전체 지도 토글
  document.getElementById("mode3dBtn").addEventListener("click", () => {
    NAV_MODE = "3d";
    // 주행 시점은 항상 내 위치 기준 → 현재 위치 층으로 복귀
    shownDong = dongOf(currentLoc.building);
    shownFloor = currentLoc.floor;
    renderFloorTabs();
    renderMap();
  });
  document.getElementById("mode2dBtn").addEventListener("click", () => {
    NAV_MODE = "2d";
    renderMap();
  });
  // 창 크기 변경: CSS 기울임 뷰 재배치 + Three.js 캔버스 크기 갱신
  // (나침반·걸음 이벤트가 없는 노트북에선 다음 렌더 계기가 없어 왜곡이 남기 때문)
  window.addEventListener("resize", () => { layout3D(); threeRender(); });
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

// 현재 사용할 방위(지도 기준 시야 방향).
// 안내 중(NAV_BASE)에는 "경로 방향 + 안내 시작 후 몸을 돌린 각도" — 어디서 테스트해도
// 처음엔 경로를 바라보고, 몸을 돌리면 그만큼 시야가 돈다 (절대 방위는 실측 전 신뢰 불가).
function activeHeading() {
  if (NAV_BASE) {
    if (USER_HEADING != null && NAV_BASE.compass0 != null) {
      return (NAV_BASE.bearing + USER_HEADING - NAV_BASE.compass0 + 360) % 360;
    }
    return NAV_BASE.bearing;
  }
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

// ── 걸음 감지 이동 (PDR: 가속도 피크 = 걸음 1보) ───────────
// 원리: 걸을 때 폰의 가속도 크기가 중력(9.8) 기준으로 출렁인다. 저역 필터를 거친
// 가속도가 임계값을 넘었다가 내려오는 순간을 '한 걸음'으로 보고, 지금 바라보는
// 방향(activeHeading)으로 보폭만큼 지도 위 현재위치를 전진시킨다.
// 센서 특성상 오차가 누적되므로 실서비스에선 QR 재스캔으로 보정하는 전제의 데모 기능.
function enableMotion() {
  if (MOTION_ON) return;
  if (!window.isSecureContext) return;          // https 필수
  const DME = window.DeviceMotionEvent;
  if (!DME) return;

  const attach = () => {
    if (MOTION_ON) return;
    MOTION_ON = true;
    window.addEventListener("devicemotion", onMotion);
  };
  if (typeof DME.requestPermission === "function") {
    // iOS: 사용자 제스처 안에서 권한 요청
    DME.requestPermission().then((r) => { if (r === "granted") attach(); }).catch(() => {});
  } else {
    attach();   // Android/기타
  }
}

function onMotion(e) {
  if (!TRACKING || !destStore) return;          // 안내 중일 때만 위치 추적
  const a = e.accelerationIncludingGravity;
  if (!a) return;
  const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
  accLP = accLP === 0 ? mag : accLP * 0.7 + mag * 0.3;   // 저역 필터(떨림 완화)
  const delta = accLP - 9.81;                            // 중력 제거
  if (!stepRising && delta > 1.1) {
    stepRising = true;                                   // 피크 상승 시작
  } else if (stepRising && delta < 0.35) {
    stepRising = false;                                  // 피크 통과 = 걸음 1보
    const now = Date.now();
    if (now - lastStepT > STEP_MIN_MS) {
      lastStepT = now;
      doStep();
    }
  }
}

// 한 걸음 전진: 보폭(m) → 평면도 픽셀로 환산해 현재위치 이동
function doStep() {
  const plan = planFor(dongOf(currentLoc.building), currentLoc.floor);
  const mpp = plan && plan.mpp ? plan.mpp : 0.4;
  const len = STEP_METERS / mpp;
  const H = (activeHeading() * Math.PI) / 180;
  if (!currentLoc._live) currentLoc = { ...currentLoc, _live: true };  // 원본 QR 데이터 보호
  currentLoc.x += Math.sin(H) * len;
  currentLoc.y -= Math.cos(H) * len;            // 화면 위 = 북
  if (plan) {                                    // 지도 밖 이탈 방지
    currentLoc.x = Math.max(10, Math.min(plan.w - 10, currentLoc.x));
    currentLoc.y = Math.max(10, Math.min(plan.h - 10, currentLoc.y));
  }
  onPositionChanged();
}

// 위치 변경 후: 지도 재렌더(경로·마커·3D 기준점·행동 지시 갱신 — 도착 판정은 guidance가 담당)
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

function computeGuidance() {
  if (!destStore) return null;
  const curPlan = planFor(dongOf(currentLoc.building), currentLoc.floor);
  const destXY = storeXY(destStore);
  const sameView = viewOf(destStore.building, destStore.floor) === viewOf(currentLoc.building, currentLoc.floor);
  const esc = curPlan && curPlan.escalator ? { x: curPlan.escalator[0], y: curPlan.escalator[1] } : null;
  const target = sameView ? destXY : esc;

  if (!target) return { key: "map", icon: "🧭", text: "지도를 참고해 이동하세요", speak: null };

  const remain = dist(currentLoc, target);
  // 도착 판정
  if (sameView && remain < arriveR(curPlan)) {
    return { key: "arrive", icon: "🏁", text: "도착! 주변 매대를 둘러보세요",
             speak: `${destStore.name}에 도착했어요! 주변 매대를 둘러보세요.` };
  }
  if (!sameView && remain < arriveR(curPlan) * 0.8) {
    const fl = floorLabel(destStore.floor);
    const move = destStore.floor > currentLoc.floor ? "올라가세요" : "내려가세요";
    return { key: "esc-arrive", icon: "🛗", text: `에스컬레이터를 타고 ${fl}으로`,
             speak: `에스컬레이터를 타고 ${fl}으로 ${move}.` };
  }

  const t = nextTurn(computeRoutePts(currentLoc, target, curPlan));
  const suffix = sameView ? "" : " (에스컬레이터 방면)";
  if (t.dir && t.distPx < 15) {
    return { key: `soon-${t.dir}`, icon: t.dir === "왼쪽" ? "↰" : "↱",
             text: `잠시 후 ${t.dir}으로`, speak: `잠시 후 ${t.dir}으로 도세요.` };
  }
  if (t.dir) {
    const m = approxMeters(t.distPx, curPlan);
    return { key: `straight-${t.dir}`, icon: "⬆",
             text: m ? `직진 ${m}m 후 ${t.dir}${suffix}` : `직진 후 ${t.dir}${suffix}`,
             speak: `${m ? `${m}미터 ` : ""}직진 후 ${t.dir}으로 도세요.` };
  }
  const m = approxMeters(remain, curPlan);
  return { key: "straight-final", icon: "⬆",
           text: m ? `직진 ${m}m${suffix}` : "화살표 방향으로 직진",
           speak: "화살표 방향으로 직진하세요." };
}

// 지시 카드 갱신. silent=true 면 TTS 없이 상태만 맞춘다 (안내 시작 직후 중복 발화 방지).
function updateGuidance(silent) {
  const g = computeGuidance();
  if (!g) return;
  document.getElementById("guideIcon").textContent = g.icon;
  document.getElementById("guideText").textContent = g.text;
  if (g.key !== lastGuideKey) {
    if (!silent && g.speak) speak(g.speak);
    lastGuideKey = g.key;
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
  if (NAV_BASE && NAV_BASE.compass0 == null) NAV_BASE.compass0 = USER_HEADING;
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; applyHeading(); });
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
  // 배경: 공식 평면도 이미지 > 자체 제작 약식 평면도(synthetic) > 격자 폴백
  if (plan && plan.file) {
    inner += `<image href="floorplans/${plan.file}" x="0" y="0" width="${vbW}" height="${vbH}"/>`;
  } else if (plan && plan.synthetic) {
    inner += drawSyntheticG1F();
  } else {
    inner += drawFloorPlanBackground(shownFloor);
  }

  // 경로/마커 (SVG 2D + Three.js 3D 공용 데이터 NAV3D 에 기록)
  const esc = plan && plan.escalator ? { x: plan.escalator[0], y: plan.escalator[1] } : null;
  NAV3D = { plan, routePts: null, dest: null, destLabel: "", esc: null, onFloorCurrent };
  if (destXY && onFloorCurrent && onFloorDest) {
    // 같은 층: 현재위치 → 목적지
    inner += routeVia(currentLoc, destXY, plan, k);
    NAV3D.routePts = computeRoutePts(currentLoc, destXY, plan);
    NAV3D.dest = destXY; NAV3D.destLabel = destStore.name;
  } else if (destXY && onFloorCurrent && !onFloorDest && esc) {
    // 층간 1단계: 현재위치 → 에스컬레이터
    inner += routeVia(currentLoc, esc, plan, k);
    inner += marker(esc.x, esc.y, "#7b5cc4", "에스컬레이터", "🛗", k);
    NAV3D.routePts = computeRoutePts(currentLoc, esc, plan);
    NAV3D.esc = esc;
  } else if (destXY && !onFloorCurrent && onFloorDest && esc) {
    // 층간 2단계: 에스컬레이터 → 목적지
    inner += routeVia(esc, destXY, plan, k);
    inner += marker(esc.x, esc.y, "#7b5cc4", "에스컬레이터", "🛗", k);
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
      ? `${plan.label} · ${plan.synthetic ? "약식" : "공식"} 안내도`
      : `${shortBuilding(currentLoc.building)} ${floorLabel(shownFloor)} · 약식 안내도`;
  }

  updateMapMode();      // 주행 시점(1인칭) / 전체 지도 배치 적용
  applyHeading();       // 헤딩 콘·HUD 화살표 갱신
  updateGuidance(lastGuideKey === null);   // 행동 지시 카드 (안내 시작 직후엔 무발화 — selectStore 인사와 중복 방지)
}

// ── 1인칭 주행 시점 (차량 내비 스타일) ─────────────────────
// 원리: 지도를 (1) 사용자 진행 방향이 위로 오게 회전, (2) 현재위치를 뷰포트 하단
// 중앙에 고정·확대, (3) CSS perspective+rotateX 로 기울여 앞쪽 경로가 멀리 보이게 한다.
// 주행 시점은 현재위치가 있는 층에서만 의미가 있으므로, 다른 층을 보는 중엔 전체 지도로 표시.
function is3DActive() {
  const onFloor = viewOf(currentLoc.building, currentLoc.floor) === `${shownDong}|${shownFloor}`;
  return NAV_MODE === "3d" && onFloor;
}

// 표시 모드 반영: 스테이지 클래스·토글 버튼·층탭 노출 → 3D면 배치 계산
// 3D는 Three.js(진짜 3D 공간)가 기본, 미지원 기기는 CSS 기울임 뷰로 자동 폴백.
function updateMapMode() {
  const stage = document.getElementById("mapStage");
  const svg = document.getElementById("mapSvg");
  const tilt = document.getElementById("fpTilt");
  const active = is3DActive();
  const useThree = active && threeSupported();
  stage.classList.toggle("mode-3d", active);
  document.getElementById("mode3dBtn").classList.toggle("active", NAV_MODE === "3d");
  document.getElementById("mode2dBtn").classList.toggle("active", NAV_MODE !== "3d");
  // 층탭은 전체 지도에서만 (주행 시점은 항상 내 층 기준)
  document.getElementById("floorTabs").classList.toggle("hidden", active);
  // Three.js 캔버스 ↔ SVG(기울임 폴백/2D) 표시 전환
  tilt.style.display = useThree ? "none" : "";
  if (T && T.canvas) T.canvas.style.display = useThree ? "block" : "none";
  if (!active) {
    svg.style.cssText = "";   // 2D: 인라인 transform 제거 → CSS 기본(width 100%) 복귀
    return;
  }
  if (useThree) { sync3D(); return; }
  layout3D();
}

// ── 진짜 3D 공간 렌더링 (Three.js) ─────────────────────────
// 바닥에 평면도 텍스처를 깔고 매대 블록(blocks3d)을 입체로 세운 뒤,
// 눈높이(1.6m) 카메라가 현재위치에서 바라보는 방향을 향한다.
// 걸음(PDR)이 카메라를 전진시키고 나침반이 카메라를 돌린다.
// 단위: 미터(픽셀좌표 × mpp). Three.js 미지원 기기는 CSS 기울임 뷰로 폴백.
let T = null;          // { renderer, camera, canvas, scene }
let NAV3D = null;      // renderMap 이 채우는 3D용 안내 데이터

let THREE_FAIL = false;   // WebGL 컨텍스트 생성 실패(구형 기기 등) → CSS 기울임 폴백
function threeSupported() { return typeof THREE !== "undefined" && !THREE_FAIL; }
function threeActive() { return !!(T && T.canvas && T.canvas.style.display !== "none" && T.scene); }
function mppOf(plan) { return plan && plan.mpp ? plan.mpp : 0.4; }

function ensureThree(stage) {
  if (T) return T;
  try {
    // WebGL 사전 감지 (미지원이면 THREE 가 콘솔 에러를 남기며 던지기 전에 조용히 폴백)
    const probe = document.createElement("canvas");
    if (!probe.getContext("webgl") && !probe.getContext("experimental-webgl")) {
      THREE_FAIL = true;
      return null;
    }
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = renderer.domElement;
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
    stage.appendChild(canvas);
    const camera = new THREE.PerspectiveCamera(62, 1, 0.2, 800);
    T = { renderer, camera, canvas, scene: null, w: 0, h: 0 };
    return T;
  } catch (e) {
    THREE_FAIL = true;   // 이후 threeSupported() = false → 기울임 뷰로 폴백
    return null;
  }
}

function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// 장면 구성: 바닥 + 매대 블록 + 통로 경로 + 목적지/에스컬레이터 핀
function sync3D() {
  const stage = document.getElementById("mapStage");
  if (!ensureThree(stage)) { updateMapMode(); return; }   // WebGL 실패 → 폴백 재진입
  const plan = NAV3D && NAV3D.plan;
  if (!plan) return;
  const mpp = mppOf(plan);
  const W = plan.w * mpp, H = plan.h * mpp;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf2ecdc);
  scene.fog = new THREE.Fog(0xf2ecdc, 25, 170);   // 먼 곳은 옅게(깊이감)

  scene.add(new THREE.HemisphereLight(0xffffff, 0xcfc7b0, 0.95));
  const sun = new THREE.DirectionalLight(0xffffff, 0.35);
  sun.position.set(60, 90, 40);
  scene.add(sun);

  // 바닥 — 단색 (평면도 텍스처는 눈높이에서 거대 색 덩어리로 보여 사용하지 않음.
  // 평면도 확인은 '전체 지도' 모드가 담당)
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshLambertMaterial({ color: 0xf6f1e4 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(W / 2, 0, H / 2);
  scene.add(floor);

  // 은은한 바닥 격자(4m 간격) — 걸을 때 이동감이 느껴지도록
  const grid = new THREE.GridHelper(Math.max(W, H), Math.round(Math.max(W, H) / 8), 0xd8d0bc, 0xe6dfcf);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;   // 지평선 모아레(검은 띠) 방지
  grid.position.set(W / 2, 0.02, H / 2);
  scene.add(grid);

  // 외곽 벽 (얕은 담장 — 실내 공간감)
  const wallMat = new THREE.MeshLambertMaterial({ color: 0xeadfc6 });
  [[W / 2, -0.4, W + 4, 0.8], [W / 2, H + 0.4, W + 4, 0.8], [-0.4, H / 2, 0.8, H], [W + 0.4, H / 2, 0.8, H]]
    .forEach(([cx, cz, sx, sz]) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, 3, sz), wallMat);
      wall.position.set(cx, 1.5, cz);
      scene.add(wall);
    });

  // 매대 블록(입체)
  (plan.blocks3d || []).forEach(([x, y, w, h, ht]) => {
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(w * mpp, ht, h * mpp),
      new THREE.MeshLambertMaterial({ color: 0xd9cba0 })
    );
    box.position.set((x + w / 2) * mpp, ht / 2, (y + h / 2) * mpp);
    scene.add(box);
  });

  // 경로: 통로를 따라가는 주황 튜브 + 진행 방향 셰브론(원뿔).
  // 발밑 구간(앞 10px)은 잘라 화면을 가리지 않게 하고, 목적지가 사실상 제자리면 생략.
  const target = NAV3D.dest || NAV3D.esc;
  const nearTarget = target && Math.hypot(target.x - currentLoc.x, target.y - currentLoc.y) < 14;
  const tubePts = trimRouteStart(NAV3D.routePts, 10);
  if (!nearTarget && tubePts && tubePts.length >= 2) {
    const v = tubePts.map(([x, y]) => new THREE.Vector3(x * mpp, 0.12, y * mpp));
    const curve = new THREE.CatmullRomCurve3(v, false, "catmullrom", 0.05);
    scene.add(new THREE.Mesh(
      new THREE.TubeGeometry(curve, 80, 0.45, 8, false),
      new THREE.MeshBasicMaterial({ color: 0xe8731a })   // 광원 무관 순색 (과노출 방지)
    ));
    // 셰브론: ~7m(14px) 간격으로 경로 방향을 가리키는 밝은 원뿔 (정적 — 상시 rAF 없음)
    const coneGeo = new THREE.ConeGeometry(0.5, 1.1, 6);
    const coneMat = new THREE.MeshBasicMaterial({ color: 0xffc07e });
    const up = new THREE.Vector3(0, 1, 0);
    let acc = 0;
    for (let i = 1; i < tubePts.length; i++) {
      const [ax, ay] = tubePts[i - 1], [bx, by] = tubePts[i];
      const seg = Math.hypot(bx - ax, by - ay);
      if (!seg) continue;
      for (let d = 14 - (acc % 14); d < seg; d += 14) {
        const t = d / seg;
        const cone = new THREE.Mesh(coneGeo, coneMat);
        cone.position.set((ax + (bx - ax) * t) * mpp, 0.3, (ay + (by - ay) * t) * mpp);
        cone.quaternion.setFromUnitVectors(up, new THREE.Vector3(bx - ax, 0, by - ay).normalize());
        scene.add(cone);
      }
      acc += seg;
    }
  }

  // 도착 링: 목적지 바닥의 반투명 주황 원 (도착 지점을 눈에 띄게)
  if (NAV3D.dest) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.6, 4, 40),
      new THREE.MeshBasicMaterial({ color: 0xe8731a, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(NAV3D.dest.x * mpp, 0.05, NAV3D.dest.y * mpp);
    scene.add(ring);
  }

  // 주변 가게 라벨: 현재 층 정밀좌표 매장 중 "경로 주변" 가까운 순 최대 10곳.
  // 현재위치 반경이 아니라 경로 기준인 이유: 주행하며 지나치는 가게가 시야에 걸리도록.
  const hereKey = `${shownDong}|${shownFloor}`;
  const routePoly = NAV3D.routePts;
  const nearDist = (s) => routePoly && routePoly.length >= 2
    ? projectOnCorridor(s, routePoly).d
    : dist(currentLoc, s);
  STORES
    .filter((s) => s !== destStore && Number.isFinite(s.x) && Number.isFinite(s.y) &&
                   viewOf(s.building, s.floor) === hereKey)
    .map((s) => ({ s, d: nearDist(s) }))
    .filter((o) => o.d < 80)                 // 경로에서 ≈40m 이내
    .sort((a, b) => a.d - b.d)
    .slice(0, 10)
    .forEach((o) => scene.add(miniLabel3D(o.s, mpp)));

  // 목적지·에스컬레이터 핀 (현재위치와 사실상 겹치면 생략 — 핀 내부에서 보게 되는 문제 방지)
  const farEnough = (p) => Math.hypot(p.x - currentLoc.x, p.y - currentLoc.y) > 14;
  if (NAV3D.dest && farEnough(NAV3D.dest)) scene.add(pin3D(NAV3D.dest, 0xe8731a, NAV3D.destLabel, mpp));
  if (NAV3D.esc && farEnough(NAV3D.esc)) scene.add(pin3D(NAV3D.esc, 0x7b5cc4, "에스컬레이터", mpp));

  T.scene = scene;
  update3DCamera();
}

// 핀: 기둥 + 구 + 이름 라벨(항상 카메라를 향하는 스프라이트)
function pin3D(pt, color, label, mpp) {
  const gp = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.4, 8), mat);
  pole.position.y = 1.7;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.65, 16, 12), mat);
  ball.position.y = 3.6;
  gp.add(pole, ball);
  if (label) {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 120;
    const g = c.getContext("2d");
    g.fillStyle = "#" + color.toString(16).padStart(6, "0");
    roundRectPath(g, 6, 6, 500, 108, 26); g.fill();
    g.fillStyle = "#fff"; g.font = "700 54px sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(label.length > 12 ? label.slice(0, 12) + "…" : label, 256, 62);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c), depthTest: false, fog: false,
    }));
    sp.scale.set(11, 2.6, 1);
    sp.position.y = 5.4;
    gp.add(sp);
  }
  gp.position.set(pt.x * mpp, 0, pt.y * mpp);
  return gp;
}

// 주변 매장 이름 미니 라벨 (기둥 없는 작은 스프라이트 — 주변에 뭐가 있는지 보여준다)
function miniLabel3D(s, mpp) {
  const c = document.createElement("canvas");
  c.width = 384; c.height = 96;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(74, 106, 82, 0.92)";
  roundRectPath(g, 6, 6, 372, 84, 22); g.fill();
  g.fillStyle = "#fff"; g.font = "700 44px sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(s.name.length > 9 ? s.name.slice(0, 9) + "…" : s.name, 192, 50);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), fog: false }));
  sp.scale.set(6.4, 1.6, 1);
  sp.position.set(s.x * mpp, 2.3, s.y * mpp);
  return sp;
}

// 카메라: 현재위치 눈높이(1.6m)에서 바라보는 방향(activeHeading)으로
function update3DCamera() {
  if (!T || !T.scene) return;
  const mpp = mppOf(NAV3D && NAV3D.plan);
  const A = (activeHeading() * Math.PI) / 180;
  const cx = currentLoc.x * mpp, cz = currentLoc.y * mpp;
  T.camera.position.set(cx, 1.7, cz);
  T.camera.lookAt(cx + Math.sin(A) * 12, 1.15, cz - Math.cos(A) * 12);
  threeRender();
}

function threeRender() {
  if (!T || !T.scene) return;
  const stage = document.getElementById("mapStage");
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) { requestAnimationFrame(threeRender); return; }   // 숨김 상태면 다음 프레임 재시도
  if (T.w !== w || T.h !== h) {
    T.w = w; T.h = h;
    T.renderer.setSize(w, h, false);
    T.camera.aspect = w / h;
    T.camera.updateProjectionMatrix();
  }
  T.renderer.render(T.scene, T.camera);
}

// 1인칭 배치 계산: 현재위치(px,py)를 기준점으로 회전·확대하고
// 그 점이 뷰포트 (가로 중앙, 세로 80%) 에 오도록 지도를 이동시킨다.
function layout3D() {
  const stage = document.getElementById("mapStage");
  if (!stage.classList.contains("mode-3d")) return;
  const svg = document.getElementById("mapSvg");
  const plan = planFor(shownDong, shownFloor);
  const vbW = plan ? plan.w : 1000;
  const vw = stage.clientWidth;
  const vh = stage.clientHeight || 340;
  if (!vw) { requestAnimationFrame(layout3D); return; }   // 아직 숨김/레이아웃 전이면 다음 프레임에 재시도
  const f = vw / vbW;                    // CSS px / SVG 단위 (지도 폭 = 뷰포트 폭 기준)
  const px = currentLoc.x * f;
  const py = currentLoc.y * f;
  const Z = plan ? 3.1 : 2.1;            // 확대 배율 (주변 매대가 크게 보이는 수준)
  svg.style.width = vw + "px";
  svg.style.position = "absolute";
  svg.style.left = (vw / 2 - px) + "px";
  svg.style.top = (vh * 0.72 - py) + "px";
  svg.style.transformOrigin = `${px}px ${py}px`;
  svg.style.transform = `rotate(${-activeHeading()}deg) scale(${Z})`;
}

// 재렌더 없이 방향 요소만 갱신: 헤딩 콘 회전 + HUD 화살표 방향/거리.
function applyHeading() {
  const H = activeHeading();

  // 헤딩 콘: 현재위치에서 사용자가 향한 방향
  const cone = document.getElementById("headCone");
  if (cone) cone.setAttribute("transform", `rotate(${H} ${currentLoc.x} ${currentLoc.y})`);

  // 진짜 3D(Three.js): 나침반 변화 → 카메라 방향 갱신
  if (threeActive()) { update3DCamera(); return; }

  // 폴백(CSS 기울임) 모드: 지도 회전 갱신 + 마커 라벨 정립(글자 역회전)
  const stage3d = document.getElementById("mapStage").classList.contains("mode-3d");
  if (stage3d) layout3D();
  document.querySelectorAll("#mapSvg .lbl").forEach((el) => {
    el.setAttribute("transform", stage3d ? `rotate(${H} ${el.dataset.x} ${el.dataset.y})` : "");
  });
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
// corridor 가 없으면 ㄱ자 꺾은선 폴백. SVG(2D)와 Three.js(3D)가 공용으로 쓴다.
function computeRoutePts(from, to, plan) {
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

// 경로를 따라 누적 거리 distPx 만큼 진행한 지점 (시야 방향 계산용)
function pointAlongRoute(distPx) {
  if (!NAV3D || !NAV3D.routePts || NAV3D.routePts.length < 2) return null;
  const pts = NAV3D.routePts;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + seg >= distPx && seg > 0) {
      const t = (distPx - acc) / seg;
      return { x: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
               y: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t };
    }
    acc += seg;
  }
  const last = pts[pts.length - 1];
  const p = { x: last[0], y: last[1] };
  // 경로가 아주 짧으면(제자리) null → 호출부에서 기존 heading 유지
  return Math.hypot(p.x - currentLoc.x, p.y - currentLoc.y) > 6 ? p : null;
}

// 경로 앞부분 lenPx 를 잘라낸 좌표 목록 (3D 튜브가 발밑을 가리지 않게)
function trimRouteStart(pts, lenPx) {
  if (!pts || pts.length < 2) return null;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + seg >= lenPx && seg > 0) {
      const t = (lenPx - acc) / seg;
      const sx = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t;
      const sy = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
      return [[sx, sy], ...pts.slice(i)];
    }
    acc += seg;
  }
  return null;   // 전체가 lenPx 이내 = 사실상 제자리
}

// 경로 SVG (2D 지도용)
function routeVia(from, to, plan, k) {
  const pts = computeRoutePts(from, to, plan);
  const d = "M " + pts.map(([x, y]) => `${Math.round(x)} ${Math.round(y)}`).join(" L ");
  const w = Math.max(5, 11 * k);
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

// 마커: 원 + 아이콘 + 라벨
function marker(x, y, color, label, glyph, k) {
  const r = Math.max(9, 24 * k);
  const fs = Math.max(9, 22 * k);
  const lw = Math.max(60, label.length * fs * 0.95 + 16 * k);
  return `
    <g>
      <circle cx="${x}" cy="${y}" r="${r}" fill="${color}" stroke="#fff" stroke-width="${Math.max(2, 5 * k)}"/>
      <text x="${x}" y="${y + fs * 0.36}" font-size="${fs}" fill="#fff" text-anchor="middle" font-weight="700">${glyph}</text>
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

  const micLabel = document.querySelector(".mic-label");

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
