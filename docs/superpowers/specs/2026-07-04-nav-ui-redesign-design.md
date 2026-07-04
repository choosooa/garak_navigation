# 네비게이션 화면 개편 설계 — 풀블리드 지도 + 행동 지시 카드

- 날짜: 2026-07-04
- 상태: 사용자 승인 완료 (A+C 조합 + 3D 선별 보강)
- 배경: 3단계 네비 화면이 "안내가 안 보인다"는 문제. ① 3D 주행 시점이 허전(무지 박스+튜브뿐),
  ② 행동 지시 부재(TTS 첫 문장이 전부), ③ 배너·툴바·범례·버튼이 수직 공간을 먹어 지도가 ~40%.

## 1. 레이아웃 — 지도 풀블리드 + 오버레이

`#stepNav`를 "지도가 배경, UI는 지도 위" 구조로 재편.

```
stepNav (헤더 아래 화면 전체, position:relative)
├─ map-stage: absolute inset:0 (테두리·라운드 제거)
├─ 상단 오버레이(.nav-overlay-top)
│   ├─ 행동 지시 카드(.guide-card): 아이콘 + [목적지명(작게) / 지시문(크게)] + 👣🔊
│   └─ 주행/전체 토글: 카드 아래 우측 플로팅
└─ 하단 오버레이(.nav-overlay-bottom, 크림 그라데이션 배경)
    ├─ .floor-row: 평면도 라벨 칩 + 층탭 — 전체 지도 모드에서만 (#stepNav:has(.mode-3d)로 숨김)
    └─ .nav-actions: ← 다른 가게 선택 · 🏠 처음으로 (크기·글씨 기존 유지)
```

- 목적지 배너(.nav-banner)는 지시 카드에 통합(`navDestName` = "○○까지"), 범례(.map-legend) 삭제.
- `#app:has(#stepNav:not(.hidden))`일 때만 `#app{height:100dvh;overflow:hidden}`, `main{padding:0}` —
  1·2단계 스크롤 동작은 불변.
- 기존 ID(mapStage/fpTilt/mapSvg/floorTabs/mapTitle/mode2dBtn/mode3dBtn/ttsBtn/trackBtn/
  backToSelect/restartBtn/navDestName) 전부 유지. 신규: guideIcon, guideText.
- 2D 모드: svg를 스테이지에 letterbox(width/height 100% + preserveAspectRatio meet).
  3D 폴백의 `height:auto` 오버라이드는 기존 규칙 유지.

## 2. 행동 지시 카드 (핵심)

- `computeGuidance()`: shownFloor와 무관하게 **현재 위치 층 기준**으로 계산.
  - target = 같은 층이면 목적지, 층간이면 현재 층 에스컬레이터.
  - `computeRoutePts(currentLoc, target, 현재층 plan)` 폴리라인에서 첫 굽이 검출:
    세그먼트 방위차 ≥ 35° = 턴, 8px 미만 세그먼트는 방위 계산에서 제외(누적 거리에는 포함).
- 상태(key)와 표시:
  - `straight-final`: ⬆ "직진 ○○m" (mpp 없으면 "화살표 방향으로 직진")
  - `straight-왼쪽/오른쪽`: ⬆ "직진 ○○m 후 왼쪽"
  - `soon-왼쪽/오른쪽` (턴까지 <15px): ↰/↱ "잠시 후 왼쪽으로"
  - `esc-arrive` (층간, 에스컬레이터 도착 반경): 🛗 "에스컬레이터를 타고 ○층으로"
  - `arrive` (도착 반경): 🏁 "도착! 주변 매대를 둘러보세요"
  - target 좌표 불가(약식 구역 등): 🧭 "지도를 참고해 이동하세요"
- 갱신: renderMap() 끝에서 호출 (걸음 PDR·층 전환·모드 전환 모두 경유).
- TTS: **state key가 바뀔 때만 1회 발화** (거리 숫자 변화로는 발화 안 함).
  selectStore의 기존 시작 안내와 중복 방지 위해 안내 시작 시 key를 무발화로 초기화.
  기존 arrivedSpoken 도착 발화는 guidance로 흡수(제거).

## 3. 3D 씬 보강 (선별)

- 경로 셰브론: 튜브 위 ~7m(14px) 간격 원뿔(ConeGeometry, 연주황 0xffb066)을 경로 방향으로 눕혀 배치. 정적(상시 rAF 루프 없음).
- 주변 가게 라벨: 현재 층 정밀좌표(s.x,s.y) 매장 중 반경 70px(≈35m) 내 가까운 순 최대 10곳,
  작은 이름 스프라이트(y≈2.2m, 기둥 없음). 목적지 매장은 제외.
- 도착 링: 목적지 바닥에 반투명 주황 링(반경 ≈4m).
- CSS 폴백·2D 지도는 변경 없음 (지시 카드는 DOM이라 모든 모드 공통).

## 4. 하지 않는 것

회전 뷰 여백 근본 해결(래스터 재투영), 상시 애니메이션 루프, 층간 자동 전환 감지,
1·2단계 화면 변경, 데이터 파일 변경.

## 5. 변경 파일·검증

- index.html(stepNav 구조, v=11) · styles.css(풀블리드/오버레이) · app.js(guidance + 3D 보강)
- 검증: browse 375x700 — 무스크롤(scrollHeight==vh), 오버레이 겹침, doStep 시뮬레이션으로
  지시 전이(직진→잠시 후→도착), 층간(esc) 지시, 2D/3D·층탭 회귀, 딥링크 회귀.
  Chrome headless(WebGL)로 셰브론·주변 라벨·도착 링 캡처. 콘솔 에러 0 유지.
