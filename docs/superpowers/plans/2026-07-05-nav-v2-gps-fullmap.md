# 가락몰 길찾기 2차 개편 구현 계획 (GPS·전체지도 단일화)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1단계 마이크 버튼 최대화, 뒤로가기 상단 배치, 주행 시점(3D) 제거 후 전체 지도 단일 모드, GPS 기반 위치 추적, 나침반에 따라 "시선이 아니라 지도가" 회전하는 UX로 개편한다.

**Architecture:** 순수 정적 웹앱(index.html + app.js + styles.css) 유지. Three.js·PDR(걸음 감지)을 제거하고, ① geolocation `watchPosition`으로 위치를 받아 ② floorplans/index.json의 지오 앵커 2점 유사변환(geoToPx)으로 평면도 픽셀좌표로 사영하며 ③ 지도는 항상 2D 한 모드 — 현재 층을 볼 때는 현재위치를 화면 중앙에 고정하고 지도를 `-heading`으로 회전(내 시선=화면 위), 다른 층은 북쪽 고정 letterbox.

**Tech Stack:** Vanilla JS, SVG, Geolocation API, DeviceOrientation API. (Three.js 제거, vendor/ 삭제)

## Global Constraints

- 검증은 로컬 서버(`python3 -m http.server 8431 --bind 127.0.0.1`) + gstack browse(뷰포트 375x700 기본)로 한다. browse 경로: `$HOME/.claude/skills/gstack/browse/dist/browse`
- **JS/CSS를 수정하면 반드시 index.html의 `?v=` 버전을 올린다** (이번 개편은 v=12). 안 올리면 headless 테스트에서도 구버전이 실행된다.
- 캐시 회피를 위해 테스트 URL에는 `&r=$RANDOM` 등 임의 쿼리를 붙인다.
- 5060 사용자 배려: 기본 글씨 19px(html font-size), 터치 목표 최소 44px 유지.
- 1·2단계는 페이지 스크롤 허용(가게 목록), 1단계·3단계는 375x700에서 스크롤 없이 한 화면.
- 모든 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` 붙임.
- 기존 ID 계약: `currentLocName, voiceBtn, voiceStatus, categoryButtons, stepInput/stepSelect/stepNav, selectMascot, selectBubble, selectHint, storeList, backToInput, navDestName, guideIcon, guideText, trackBtn, ttsBtn, mapStage, mapSvg, mapTitle, floorTabs, backToSelect, restartBtn` 유지.

## 사전 조사 결과 (OSM, 계획의 근거 데이터)

- 가락몰 판매동 = OSM way **984878800** (building=commercial, name=판매동). 22개 꼭짓점.
- 장축 길이 ≈ 185m, 장축 방위 ≈ **157.9°**(NNW→SSE). 폭 ≈ 39~43m.
- 출입구 추정 실좌표 (건물 양끝 짧은 변의 중점):
  - **서측 입구(북서쪽 끝)** ≈ `37.494454, 127.115646`
  - **동측 입구(남동쪽 끝)** ≈ `37.492726, 127.116519`
  - 두 점 사이 실거리 ≈ **207m** ↔ 1층 평면도 픽셀거리 675px(65→740) → **실제 축척 ≈ 0.31 m/px** (현재 index.json mpp=0.5는 약 1.6배 과대)
- ⚠️ **현장 검증 필요 가정**: 앱의 "서측"이 건물 북서쪽 끝이라는 가정. 틀렸다면(반대) 두 앵커의 ll만 서로 바꾸면 됨. 검증법: 서측 입구에서 동측으로 걸을 때 지도 점이 반대로 가면 앵커 스왑.

## File Structure

- Modify: `index.html` — stepInput/stepNav 구조 변경, three.min.js 스크립트 제거, v=12
- Modify: `styles.css` — 1단계 dvh 레이아웃, back-chip, 3D 관련 규칙 제거, 지도 회전 전환
- Modify: `app.js` — Three/PDR/모드토글 제거, geoToPx·onGPS·layoutMap 추가, applyHeading 개편
- Modify: `floorplans/index.json` — G|1F·G|B1·G|3F에 `geo.anchors` 추가, mpp 0.5→0.31
- Delete: `vendor/three.min.js` (vendor/ 디렉터리째)

---

### Task 1: 주행 시점(3D)·PDR 제거 — 전체 지도 단일 모드의 골격

**Files:**
- Modify: `index.html` (stepNav에서 view-toggle·fp-tilt 제거, three 스크립트 제거)
- Modify: `app.js` (Three.js 블록, layout3D, updateMapMode, NAV_MODE, PDR 전부 제거)
- Modify: `styles.css` (mode-3d·fp-tilt·view-toggle 규칙 제거)
- Delete: `vendor/`

**Interfaces:**
- Produces: `renderMap()`은 SVG만 그리고 마지막에 `layoutMap()`(Task 4에서 완성, 이 태스크에선 임시 스텁)과 `updateGuidance()`를 호출. `activeHeading()`은 `USER_HEADING ?? currentLoc.heading ?? 0`으로 단순화.
- 유지: `computeRoutePts, projectOnCorridor, routeVia, marker, headingCone, computeGuidance, updateGuidance, renderFloorTabs, enableCompass, onOrientation` — 삭제 금지.

- [ ] **Step 1: index.html 정리**

stepNav에서 아래 두 블록을 제거하고 svg를 map-stage 직속으로:

```html
<!-- 제거: <div class="view-toggle">…mode3dBtn/mode2dBtn…</div> -->
<!-- 제거: <div class="fp-tilt" id="fpTilt"> 래퍼 (svg는 유지) -->
<div class="map-stage" id="mapStage">
  <svg id="mapSvg" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet"
       xmlns="http://www.w3.org/2000/svg" role="img" aria-label="가락몰 평면도"></svg>
</div>
```

그리고 `<script src="vendor/three.min.js"></script>` 라인 삭제.

- [ ] **Step 2: app.js에서 3D·PDR 제거**

삭제 대상(전부): `NAV_MODE`, `TRACKING` 초기화 주석의 PDR 언급, `stepRising/accLP/lastStepT/STEP_METERS/STEP_MIN_MS/MOTION_ON`, `enableMotion()/onMotion()/doStep()`, `NAV_BASE`(선언·모든 대입), `pointAlongRoute()`, `trimRouteStart()`, `is3DActive()/updateMapMode()/layout3D()`, `T/NAV3D 선언부터 threeRender()까지 Three.js 블록 전체`(`ensureThree, roundRectPath, sync3D, pin3D, miniLabel3D, update3DCamera, threeRender, threeSupported, threeActive, mppOf, THREE_FAIL`), `mode3dBtn/mode2dBtn` 리스너, `window.addEventListener("resize", …)`의 threeRender 호출.

`selectStore()`에서 NAV_BASE/시야 계산 블록(`let tgt = pointAlongRoute(30) … applyHeading();`)을 삭제하고 `NAV_MODE = "3d"` 줄도 삭제. `enableMotion()` 호출은 Task 6에서 `enableGPS()`로 바뀌므로 이 태스크에선 일단 줄 삭제.

`activeHeading()`을 다음으로 교체:

```js
// 현재 사용할 방위: 실시간 나침반 > QR 고정값
function activeHeading() {
  if (USER_HEADING != null) return USER_HEADING;
  return currentLoc.heading ?? 0;
}
```

`renderMap()` 끝부분을 다음으로 교체 (NAV3D 기록 줄들은 삭제하되 esc 지역변수·경로 그리기는 유지):

```js
  svg.innerHTML = inner;
  // 지도 타이틀 (기존 그대로)
  …
  layoutMap();          // 배치·회전 (Task 4 완성, 지금은 스텁)
  applyHeading();       // 헤딩 콘 회전
  updateGuidance(lastGuideKey === null);
```

`renderMap()` 안에서 `NAV3D = {...}` / `NAV3D.routePts = …` / `NAV3D.dest…` 줄은 모두 삭제(2D 경로 `inner += routeVia(...)`는 유지).

임시 스텁과 applyHeading 교체:

```js
// 지도 배치 스텁 — Task 4에서 회전·따라가기 구현으로 교체
function layoutMap() {}

// 재렌더 없이 방향 요소만 갱신: 헤딩 콘 회전 + 지도 회전(layoutMap)
function applyHeading() {
  const H = activeHeading();
  const cone = document.getElementById("headCone");
  if (cone) cone.setAttribute("transform", `rotate(${H} ${currentLoc.x} ${currentLoc.y})`);
  layoutMap();
}
```

`window.addEventListener("resize", () => layoutMap());`로 교체.

- [ ] **Step 3: styles.css 정리**

삭제: `.fp-tilt` 규칙, `.map-stage.mode-3d` 3개 규칙 전부, `.view-toggle` 2개 규칙, `#stepNav:has(.map-stage.mode-3d) .floor-row` 규칙.
`#mapSvg`는 당분간 `display:block; width:100%; height:100%;` 유지 (Task 4에서 인라인 배치가 덮음).

- [ ] **Step 4: vendor 삭제 및 로컬 검증**

```bash
git rm -r vendor
(python3 -m http.server 8431 --bind 127.0.0.1 >/dev/null 2>&1 &)
B=$HOME/.claude/skills/gstack/browse/dist/browse
$B viewport 375x700
$B goto "http://127.0.0.1:8431/?loc=g-b1-west&go=과일&pick=1&r=$RANDOM"
$B console --errors
$B js "JSON.stringify({guide: document.getElementById('guideText').textContent, tabs: document.querySelectorAll('#floorTabs button').length, three: typeof THREE})"
```

기대: 콘솔 에러 0, guide 문구 표시, tabs ≥ 3, `three: "undefined"`. 지도는 아직 화면에 letterbox로만 보임(회전 없음 — 정상, Task 4 전).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: 주행 시점(3D)·걸음 감지(PDR) 제거 — 전체 지도 단일 모드

Three.js(vendor 포함)·CSS 기울임 뷰·모드 토글·PDR을 제거하고
지도는 2D 전체 지도 한 모드만 남긴다. GPS 추적(후속 커밋) 준비.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 1단계 마이크 버튼 최대화 (스크롤 없이)

**Files:**
- Modify: `styles.css` (stepInput dvh 고정 레이아웃 + 마이크 동적 크기)

**Interfaces:**
- Consumes: 기존 stepInput DOM 구조 (mascot-say.intro → voice-wrap → voiceStatus → categoryButtons). HTML 변경 없음.

- [ ] **Step 1: 1단계를 한 화면 고정 flex로 만들고 마이크를 남는 높이만큼 키운다**

styles.css의 `/* ── 1단계: 음성 입력 ──` 섹션을 다음으로 교체하고, 공통 영역에 :has 규칙을 추가:

```css
/* 1단계도 네비처럼 한 화면 고정 — 남는 세로 공간을 전부 마이크에 준다 */
#app:has(#stepInput:not(.hidden)) { height: 100vh; height: 100dvh; min-height: auto; overflow: hidden; }
#app:has(#stepInput:not(.hidden)) main { min-height: 0; display: flex; }
#stepInput { flex: 1; min-height: 0; }

/* ── 1단계: 음성 입력 ──────────────────── */
.voice-wrap {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 8px;
  text-align: center;
}
.mic-btn {
  /* 화면 폭 58% vs 남는 높이 기반 상한 중 작은 쪽 — 어떤 폰에서도 스크롤 없이 최대 */
  width: clamp(132px, min(58vw, calc(100dvh - 420px)), 320px);
  aspect-ratio: 1 / 1;
  border: none; border-radius: 50%;
  background: radial-gradient(circle at 32% 28%, #2c9450, var(--green) 62%);
  box-shadow: 0 8px 22px rgba(30, 122, 60, 0.4);
  cursor: pointer;
  transition: transform 0.12s ease;
  display: flex; align-items: center; justify-content: center;
}
.mic-btn svg { width: 46%; height: 46%; }
.mic-btn:active { transform: scale(0.94); }
.mic-btn.listening {
  background: radial-gradient(circle at 32% 28%, #f28b3b, var(--orange) 62%);
  box-shadow: 0 0 0 10px rgba(232, 115, 26, 0.22);
  animation: pulse 1.1s infinite;
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 6px rgba(232, 115, 26, 0.25); }
  50% { box-shadow: 0 0 0 16px rgba(232, 115, 26, 0.1); }
}
.mic-label { font-size: 1.05rem; font-weight: 700; color: var(--green-dark); }
.voice-status { text-align: center; min-height: 1.2em; font-size: 0.95rem; color: var(--orange); font-weight: 700; }
```

기존 `.mic-btn svg { width: 62px; height: 62px; }` 규칙(파일 하단 공통 영역)은 삭제.
설명: 고정 요소 합(헤더≈48 + 인트로 말풍선≈118 + 라벨/상태≈60 + 카테고리 3줄≈195 + 여백≈24) ≈ 420px. `100dvh - 420px`가 마이크가 쓸 수 있는 높이.

- [ ] **Step 2: 뷰포트 3종에서 무스크롤·크기 검증**

```bash
B=$HOME/.claude/skills/gstack/browse/dist/browse
for VP in 375x640 375x700 390x844; do
  $B viewport $VP
  $B goto "http://127.0.0.1:8431/?r=$RANDOM" >/dev/null; sleep 0.4
  $B js "JSON.stringify({vp:'$VP', mic: document.querySelector('.mic-btn').offsetWidth, noScroll: document.documentElement.scrollHeight <= window.innerHeight+1})"
done
$B viewport 375x700
$B screenshot /tmp/step1-bigmic.png
```

기대: 모든 뷰포트에서 `noScroll: true`, mic ≥ 190(700 기준 ≈ 218~250). 스크린샷 Read로 시각 확인(카테고리 버튼 잘림 없음).

- [ ] **Step 3: Commit**

```bash
git add styles.css
git commit -m "feat: 1단계 마이크 버튼을 화면 남는 높이만큼 최대화 (스크롤 없이)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 뒤로가기 버튼 상단 배치 (2·3단계)

**Files:**
- Modify: `index.html` (버튼 위치 이동)
- Modify: `styles.css` (back-chip 신설, big-back·nav-actions 제거)

**Interfaces:**
- Consumes: 기존 리스너는 ID 기준(`backToInput/backToSelect/restartBtn`)이라 JS 무변경.
- Produces: 클래스 `back-chip`(공용 상단 뒤로가기 칩), `.nav-chip-row`(3단계 칩 줄).

- [ ] **Step 1: index.html — 2단계 버튼을 목록 위로**

stepSelect에서 `<button id="backToInput" …>` 줄을 `<div class="mascot-say">` **앞**으로 옮기고 클래스 교체:

```html
<section id="stepSelect" class="step-view hidden">
  <button id="backToInput" class="back-chip" type="button">← 다른 품목 찾기</button>
  <div class="mascot-say"> … </div>
  …
</section>
```

(리스트 아래에 있던 원래 버튼 줄은 삭제)

- [ ] **Step 2: index.html — 3단계 버튼을 지시 카드 아래 상단으로**

`nav-overlay-top`에서 (Task 1에서 view-toggle이 빠진 자리에) 칩 줄 추가, `nav-overlay-bottom`의 `.nav-actions` 블록 삭제:

```html
<div class="nav-overlay-top">
  <div class="guide-card"> … </div>
  <div class="nav-chip-row">
    <button id="backToSelect" class="back-chip" type="button">← 다른 가게 선택</button>
    <button id="restartBtn" class="back-chip" type="button">🏠 처음으로</button>
  </div>
</div>
<div class="nav-overlay-bottom">
  <div class="floor-row">
    <span id="mapTitle" class="floor-label-chip">평면도</span>
    <div id="floorTabs" class="floor-tabs"></div>
  </div>
</div>
```

- [ ] **Step 3: styles.css — back-chip 추가, big-back/nav-actions 삭제**

`.big-back` 2개 규칙과 `.nav-actions` 규칙을 삭제하고 추가:

```css
/* 상단 뒤로가기 칩 (2·3단계 공용) — 5060 배려로 터치 높이 44px 이상 */
.back-chip {
  align-self: flex-start;
  border: 2px solid var(--line);
  background: #fff;
  border-radius: 999px;
  min-height: 44px;
  padding: 8px 16px;
  font-size: 0.95rem; font-weight: 800; color: #55605a;
  cursor: pointer;
  box-shadow: var(--card-shadow);
  white-space: nowrap;
}
.back-chip:active { border-color: var(--green); color: var(--green-dark); }
.nav-chip-row { display: flex; gap: 8px; }
.nav-chip-row .back-chip { align-self: auto; }
```

또한 `.nav-overlay-top`의 `align-items: flex-end;`를 `align-items: stretch;`로 바꾸고 `.nav-chip-row`에 `justify-content: flex-start;`를 둔다(칩이 왼쪽 정렬).

- [ ] **Step 4: 검증**

```bash
B=$HOME/.claude/skills/gstack/browse/dist/browse
$B goto "http://127.0.0.1:8431/?go=과일&r=$RANDOM" >/dev/null; sleep 0.4
$B js "const b=document.getElementById('backToInput').getBoundingClientRect(); JSON.stringify({backTopY: Math.round(b.top), h: Math.round(b.height)})"
$B js "document.querySelector('.store-card').click()" ; sleep 0.5
$B js "const r=document.getElementById('backToSelect').getBoundingClientRect(); JSON.stringify({navBackY: Math.round(r.top), h: Math.round(r.height), works: true})"
$B js "document.getElementById('backToSelect').click(); !document.getElementById('stepSelect').classList.contains('hidden')"
$B console --errors
$B screenshot /tmp/back-top.png
```

기대: backTopY < 150(상단), h ≥ 44, 클릭 시 2단계 복귀 true, 콘솔 에러 0.

- [ ] **Step 5: Commit**

```bash
git add index.html styles.css
git commit -m "feat: 뒤로가기 버튼을 2·3단계 상단으로 이동 (back-chip)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 지도 회전 — "시선이 아니라 지도가 움직인다" + 지도 최대화

**Files:**
- Modify: `app.js` (layoutMap 스텁 → 실제 구현)
- Modify: `styles.css` (#mapSvg 전환 애니메이션)

**Interfaces:**
- Consumes: Task 1의 `layoutMap()` 스텁, `activeHeading()`, `.lbl[data-x][data-y]` 마커 라벨 규약.
- Produces: `layoutMap()` — 현재 층이면 현재위치를 화면 중앙에 고정하고 지도를 `-activeHeading()`으로 회전, 다른 층이면 북쪽 고정 letterbox. 마커 라벨은 역회전으로 글자 정립.

- [ ] **Step 1: layoutMap 구현 (app.js 스텁 교체)**

```js
// 지도 배치 — 전체 지도 단일 모드.
// 현재 위치 층: 현재위치를 화면 중앙에 고정하고 지도를 -heading 회전 (폰을 돌리면
//   시선 표시가 아니라 지도가 돈다 = 내 정면이 항상 화면 위).
// 다른 층 열람: 북쪽 고정 + letterbox 중앙 배치.
function layoutMap() {
  const stage = document.getElementById("mapStage");
  const svg = document.getElementById("mapSvg");
  const plan = planFor(shownDong, shownFloor);
  const vbW = plan ? plan.w : 1000;
  const vbH = plan ? plan.h : 1000;
  const vw = stage.clientWidth, vh = stage.clientHeight;
  if (!vw || !vh) { requestAnimationFrame(layoutMap); return; }   // 숨김 상태면 재시도
  const f = Math.min(vw / vbW, vh / vbH);   // 지도 전체가 보이는 letterbox 배율
  svg.style.position = "absolute";
  svg.style.width = vbW * f + "px";
  svg.style.height = vbH * f + "px";

  const onFloor = viewOf(currentLoc.building, currentLoc.floor) === `${shownDong}|${shownFloor}`;
  const H = onFloor ? activeHeading() : 0;
  if (onFloor) {
    // 현재위치를 화면 중앙에 고정하고 그 점을 축으로 회전
    const px = currentLoc.x * f, py = currentLoc.y * f;
    svg.style.left = vw / 2 - px + "px";
    svg.style.top = vh / 2 - py + "px";
    svg.style.transformOrigin = `${px}px ${py}px`;
    svg.style.transform = `rotate(${-H}deg)`;
  } else {
    svg.style.left = (vw - vbW * f) / 2 + "px";
    svg.style.top = (vh - vbH * f) / 2 + "px";
    svg.style.transform = "";
  }
  // 마커 라벨 글자 정립 (지도가 -H 돌았으니 라벨은 +H 역회전)
  document.querySelectorAll("#mapSvg .lbl").forEach((el) => {
    el.setAttribute("transform", onFloor && H ? `rotate(${H} ${el.dataset.x} ${el.dataset.y})` : "");
  });
}
```

- [ ] **Step 2: 부드러운 회전 전환 (styles.css)**

```css
#mapSvg {
  display: block;
  transition: transform 0.18s linear, left 0.18s linear, top 0.18s linear;  /* 나침반·GPS 갱신 부드럽게 */
  will-change: transform;
}
```

(기존 `#mapSvg { width:100%; height:100%; }` 규칙은 삭제 — 인라인이 담당)

- [ ] **Step 3: 검증 — 회전·라벨 정립·다른 층 북고정**

```bash
B=$HOME/.claude/skills/gstack/browse/dist/browse
$B goto "http://127.0.0.1:8431/?loc=g-b1-west&go=과일&pick=1&r=$RANDOM" >/dev/null; sleep 0.6
$B js "USER_HEADING=90; applyHeading(); document.getElementById('mapSvg').style.transform"
$B screenshot /tmp/rotate-90.png
$B js "USER_HEADING=225; applyHeading(); const l=document.querySelector('#mapSvg .lbl'); JSON.stringify({map: document.getElementById('mapSvg').style.transform, lbl: l && l.getAttribute('transform')})"
$B js "[...document.querySelectorAll('#floorTabs button')].find(b=>b.textContent==='3층').click(); document.getElementById('mapSvg').style.transform"
$B console --errors
```

기대: `rotate(-90deg)` → `rotate(-225deg)`·라벨 `rotate(225 …)`, 3층 열람 시 transform 빈 문자열(북 고정), 콘솔 에러 0. 스크린샷에서 현재위치가 화면 중앙, 글자는 수평.

- [ ] **Step 4: Commit**

```bash
git add app.js styles.css
git commit -m "feat: 나침반 회전을 지도에 적용 — 현재위치 중앙 고정, 폰을 돌리면 지도가 돈다

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: GPS 지오레퍼런스 — 앵커 데이터 + geoToPx 변환

**Files:**
- Modify: `floorplans/index.json` (G|1F·G|B1·G|3F에 geo.anchors, mpp 0.31)
- Modify: `app.js` (geoToPx 함수)

**Interfaces:**
- Produces: `geoToPx(lat, lng, plan) → {x, y} | null` — plan.geo.anchors 2점 유사변환. `plan.geo = { anchors: [{px:[x,y], ll:[lat,lng]}, …] }`.
- Consumes: OSM 조사 결과(계획서 상단): 서측 `37.494454,127.115646`, 동측 `37.492726,127.116519`.

- [ ] **Step 1: index.json에 지오 앵커 추가**

G|1F(synthetic)·G|B1·G|3F 항목에 각 평면도의 서측·동측 입구 픽셀로 anchors를 넣고 mpp를 0.31로 수정한다. 픽셀 기준: 1F는 locations.json의 `g-f1-west(65,250)`/`g-f1-east(740,236)`, B1은 `g-b1-west(78,228)`/`g-b1-east(745,115)`… **주의: B1 동측(745,115)은 1F와 y가 다름 — B1은 자체 QR 픽셀을 그대로 앵커로 쓴다.** 3F는 서·동 끝 통로점(corridor 첫·끝점)을 앵커 픽셀로 쓴다.

```json
// G|1F 예 (B1·3F 동일 패턴, px만 해당 층 값)
{
  "dong": "G", "floorCode": "1F", …기존 필드…,
  "mpp": 0.31,
  "geo": {
    "anchors": [
      { "px": [65, 250],  "ll": [37.494454, 127.115646] },
      { "px": [740, 236], "ll": [37.492726, 127.116519] }
    ]
  }
}
```

- [ ] **Step 2: geoToPx 구현 (app.js, storeXY 근처에 추가)**

```js
// 위경도 → 평면도 픽셀. plan.geo.anchors 2점으로 유사변환(축척+회전) 계산.
// 원리: A 앵커 기준 동거리(ENU) 미터로 편 뒤, A→B 실벡터가 A→B 픽셀벡터로 가는
// 복소 배율 k를 구해 임의 점에 적용한다. (SVG y는 남쪽+라 북+를 뒤집는다)
function geoToPx(lat, lng, plan) {
  const g = plan && plan.geo;
  if (!g || !g.anchors || g.anchors.length < 2) return null;
  const [A, B] = g.anchors;
  const M_LAT = 110950;
  const M_LNG = 111320 * Math.cos((A.ll[0] * Math.PI) / 180);
  const enu = (la, ln) => ({ x: (ln - A.ll[1]) * M_LNG, y: -(la - A.ll[0]) * M_LAT }); // y남+
  const e = enu(B.ll[0], B.ll[1]);                     // A→B 실벡터 (지도 좌표계 방향)
  const p = { x: B.px[0] - A.px[0], y: B.px[1] - A.px[1] };  // A→B 픽셀벡터
  const den = e.x * e.x + e.y * e.y;
  if (!den) return null;
  const s = (p.x * e.x + p.y * e.y) / den;             // k = s + i·r  (px = k · enu)
  const r = (p.y * e.x - p.x * e.y) / den;
  const q = enu(lat, lng);
  return { x: A.px[0] + s * q.x - r * q.y, y: A.px[1] + r * q.x + s * q.y };
}
```

- [ ] **Step 3: 변환 자체 검증 (앵커가 자기 픽셀로 돌아오는지 + 중간점)**

```bash
B=$HOME/.claude/skills/gstack/browse/dist/browse
$B goto "http://127.0.0.1:8431/?loc=g-f1-west&r=$RANDOM" >/dev/null; sleep 0.5
$B js "const p=planFor('G',1); const a=geoToPx(37.494454,127.115646,p); const b=geoToPx(37.492726,127.116519,p); const m=geoToPx(37.49359,127.116083,p); JSON.stringify({west:[Math.round(a.x),Math.round(a.y)], east:[Math.round(b.x),Math.round(b.y)], mid:[Math.round(m.x),Math.round(m.y)]})"
```

기대: west≈[65,250], east≈[740,236] (오차 ±1px), mid는 두 앵커의 중간 부근([~402,~243] ±10).

- [ ] **Step 4: Commit**

```bash
git add floorplans/index.json app.js
git commit -m "feat: 평면도 지오레퍼런스(anchors) + geoToPx 유사변환, mpp 실측 보정(0.5→0.31)

OSM way 984878800(판매동) 실측: 서측~동측 207m ↔ 675px → 0.31m/px.
앵커 ll은 OSM 추정치 — 현장에서 방향 반대면 두 앵커 ll 스왑.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: GPS 위치 추적 (watchPosition) + 📍 토글 + 디버그 HUD

**Files:**
- Modify: `app.js` (enableGPS/onGPS, trackBtn 재정의, 디버그 훅)
- Modify: `index.html` (trackBtn 아이콘 👣→📍)

**Interfaces:**
- Consumes: Task 5의 `geoToPx`, 기존 `onPositionChanged()`(rAF renderMap), `TRACKING` 플래그, `trackBtn`.
- Produces: `enableGPS()/disableGPS()/onGPS(pos)`, 디버그 훅 `window.__gps(lat,lng,acc)`, URL 파라미터 `?gps=lat,lng`(1회 주입), `?debug=1` 시 GPS 원시값 HUD.

- [ ] **Step 1: index.html — 토글 아이콘 교체**

```html
<button id="trackBtn" class="tts-btn" type="button" aria-label="위치 따라가기 켜기/끄기">📍</button>
```

- [ ] **Step 2: app.js — GPS 추적 구현**

PDR이 있던 자리에:

```js
// ── GPS 위치 추적 ──────────────────────────────────────────
// watchPosition 으로 위치를 받아 지오 앵커(geoToPx)로 평면도 픽셀에 사영한다.
// 실내(지하)는 정확도가 나쁘므로 accuracy 게이트로 거르고, 통과분만 저역 필터로 반영.
// 층 판단은 GPS 로 불가 — 층은 QR/층탭이 결정하고 GPS 는 x,y 만 움직인다.
let GPS_WATCH = null;
const GPS_MAX_ACC = 35;   // m — 이보다 부정확한 픽스는 무시

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

// 콘솔·데모용 훅: 가짜 GPS 주입
window.__gps = (lat, lng, acc = 5) =>
  onGPS({ coords: { latitude: lat, longitude: lng, accuracy: acc } });
```

`selectStore()`의 (Task 1에서 지운) enableMotion 자리에 `enableGPS();` 추가. `init()` 마지막에 `?gps=` 파라미터 처리:

```js
  const fakeGps = params.get("gps");   // 데모·테스트: ?gps=37.4944,127.1157
  if (fakeGps) {
    const [la, ln] = fakeGps.split(",").map(Number);
    if (Number.isFinite(la) && Number.isFinite(ln)) window.__gps(la, ln);
  }
```

trackBtn 리스너 교체:

```js
  const trackBtn = document.getElementById("trackBtn");
  trackBtn.addEventListener("click", () => {
    TRACKING = !TRACKING;
    trackBtn.classList.toggle("off", !TRACKING);
    if (TRACKING) {
      enableGPS();      // 사용자 제스처 안에서 권한 요청
      speak("위치 따라가기를 켰어요. 걸으면 지도 위 내 위치가 움직여요.");
    } else {
      disableGPS();
      speak("위치 따라가기를 껐어요.");
    }
  });
```

- [ ] **Step 3: 가짜 GPS로 이동·지시 갱신 검증**

```bash
B=$HOME/.claude/skills/gstack/browse/dist/browse
$B goto "http://127.0.0.1:8431/?loc=g-f1-west&go=축산&pick=1&r=$RANDOM" >/dev/null; sleep 0.6
$B js "const before=[Math.round(currentLoc.x),Math.round(currentLoc.y)]; __gps(37.49359,127.116083); __gps(37.49359,127.116083); __gps(37.49359,127.116083); JSON.stringify({before, after:[Math.round(currentLoc.x),Math.round(currentLoc.y)], guide: document.getElementById('guideText').textContent})"
$B js "__gps(37.4930,127.1170,60); [Math.round(currentLoc.x),Math.round(currentLoc.y)]"   # acc 60m → 무시돼야 함
$B console --errors
```

기대: after가 중앙([~400,~245]) 방향으로 이동(저역 필터라 3회 주입 후 ≈ 대부분 수렴), guide 문구가 남은 경로 기준으로 갱신, 저정확도 픽스는 위치 불변, 콘솔 에러 0.

- [ ] **Step 4: 도착 시나리오 (가짜 GPS로 동측 끝까지)**

```bash
$B js "for(let i=0;i<8;i++) __gps(37.492726,127.116519); document.getElementById('guideText').textContent"
```

기대: `도착! 주변 매대를 둘러보세요` (목적지가 동측 근처 축산 매장일 때) 또는 남은 직진 지시(목적지 위치에 따라). 화면 중앙 고정·회전 유지.

- [ ] **Step 5: Commit**

```bash
git add app.js index.html
git commit -m "feat: GPS 위치 추적(watchPosition) — 정확도 게이트·저역 필터·📍 토글·디버그 HUD

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: 통합 검증 · 캐시 v=12 · 배포

**Files:**
- Modify: `index.html` (`styles.css?v=12`, `app.js?v=12`)
- Modify: `README.md` (주행 시점·걸음 감지 문구 → 전체 지도·GPS 문구로 갱신, `?gps=` 데모 파라미터 추가)

- [ ] **Step 1: 버전 범프 + README 갱신**

index.html에서 `?v=11` 두 곳을 `?v=12`로. README의 "발표 데모 시나리오"에서 주행 시점/걸음 안내 문구를 제거하고 다음 추가: "위치 추적: GPS 기반(📍 토글). 데모용 가짜 위치는 `?gps=37.4944,127.1157`, 원시값 확인은 `&debug=1`."

- [ ] **Step 2: 전체 회귀 (기존 QA 세트 축약판)**

```bash
B=$HOME/.claude/skills/gstack/browse/dist/browse
# 3단계 흐름 + 딥링크 + 층간 + 뒤로가기
$B goto "http://127.0.0.1:8431/?r=$RANDOM" >/dev/null; sleep 0.4
$B js "document.querySelectorAll('#categoryButtons button')[0].click()"; sleep 0.4
$B js "document.querySelector('.store-card').click()"; sleep 0.5
$B js "JSON.stringify({noScroll: document.documentElement.scrollHeight<=window.innerHeight+1, guide: !!document.getElementById('guideText').textContent})"
$B js "document.getElementById('backToSelect').click(); document.getElementById('backToInput').click(); !document.getElementById('stepInput').classList.contains('hidden')"
$B goto "http://127.0.0.1:8431/?loc=g-b1-esc&go=건어물&pick=1&r=$RANDOM" >/dev/null; sleep 0.6
$B js "document.getElementById('guideText').textContent"   # 에스컬레이터를 타고 3층으로
$B console --errors
# 1단계 대형 마이크·2단계 상단 뒤로가기 스크린샷 확인
```

기대: 전부 통과, 콘솔 에러 0.

- [ ] **Step 3: 커밋 + 푸시 + 배포 확인**

```bash
git add -A && git commit -m "chore: 2차 개편 마무리 — 캐시 버스팅 v=12, README 갱신

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin main
sleep 45
curl -s "https://dh-jeon.github.io/garak_navigation/?nc=$(date +%s)" | grep -o 'v=12' | head -1   # 기대: v=12
```

- [ ] **Step 4: 사용자 현장 검증 안내 (사람 몫)**

폰에서 `?loc=g-f1-west&debug=1`로 열고 서측 입구에 서서 HUD의 위경도를 확인 → 계획서의 앵커 추정치와 10m 이상 어긋나면 그 실측값으로 index.json anchors 교체. 동측으로 걸을 때 점이 반대로 가면 두 앵커의 ll을 스왑.

---

## Self-Review 결과

- 요구 5건 ↔ Task 매핑: 마이크 최대화=T2, 뒤로가기 상단=T3, 주행시점 제거·전체지도 단일=T1, GPS 추적=T5+T6, 지도 회전=T4, 지도 최대화=T1/T3/T4(오버레이 축소+풀블리드 유지). 누락 없음.
- 타입/시그니처 일관성: `layoutMap()`(T1 스텁→T4 구현), `geoToPx(lat,lng,plan)`(T5 정의→T6 사용), `onPositionChanged()`(기존→T6 재사용) 확인.
- 알려진 리스크(계획에 반영): ① 앵커 ll은 OSM 추정 — T7 Step4 현장 보정 절차 포함. ② 지하층 GPS 부정확 — accuracy 게이트로 자동 폴백(QR 고정). ③ mpp 0.31 보정으로 후보 카드 거리 표기가 짧아짐(정확해짐) — 의도된 변화.
