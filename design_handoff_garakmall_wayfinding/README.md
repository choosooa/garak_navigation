# Handoff: 가락몰 길찾기 — 모바일 웹앱 UI 리디자인

## Overview
서울 가락몰(대형 식자재 복합쇼핑몰) 실내 내비게이션 웹앱의 3단계 화면 리디자인.
① 품목 입력(음성 우선) → ② 가게 후보 선택 → ③ 실내 네비게이션.
주 사용자는 50~60대 장보기 고객 — 큰 글씨(기본 19px+), 큰 터치 영역(52px+), 단순한 화면이 핵심 요구사항.

## About the Design Files
이 번들의 파일은 **HTML로 만든 디자인 레퍼런스**입니다. 그대로 복사해 쓰는 프로덕션 코드가 아니라, 의도된 룩앤필을 보여주는 목업입니다.
할 일: **이 디자인을 대상 코드베이스(기존 index.html / styles.css)의 환경과 패턴에 맞게 재구현**하세요. 다만 `mockup.html`은 프레임워크 없는 순수 HTML+CSS이므로, 대상도 순수 HTML/CSS라면 클래스·토큰을 거의 그대로 옮겨도 됩니다.

- `mockup.html` — 3개 화면(각 390×844)을 가로로 나란히 배치한 정적 목업. JS 없음. **이 파일이 기준(source of truth)**
- `mockup_nav_2.5d.html` — 화면 3의 C안: **2.5D 벡터 지도 네비게이션** 단독 목업 (390×844, JS 없음)
- `가락몰 길찾기 리디자인.dc.html` — 디자인 툴 원본(참고용, 툴 전용 런타임 포함 — 이식하지 말 것)

## Fidelity
**High-fidelity.** 색상·타이포·간격·라운드·그림자 모두 최종값. 픽셀 수준으로 재현할 것.
단, 두 곳은 placeholder:
1. **마스코트**(점선 사각 박스 `.mascot`) → 실제 무농이/신선이 이미지로 교체
2. **화면 3 지도**(CSS 블록으로 그린 개략도) → 실제 평면도 PNG + 경로 오버레이로 교체. 오버레이 스타일(주황 점선 경로, 초록 내 위치 점, 주황 강조 목적지)은 유지

## Screens / Views

### 화면 1 — 품목 입력
- 목적: 사고 싶은 품목을 음성(1순위) / 텍스트 검색(2순위) / 카테고리(3순위)로 입력
- 레이아웃: 세로 flex 단일 컬럼, 스크롤 없이 844px 안에 전부 표시
- 헤더: 앱명 22px/800 진초록 어두운 색(#155c2c) + 현재 위치 칩(연초록 pill, 16px/700)
- 마스코트 64px placeholder + 말풍선(흰 카드, 좌하단 radius 6px, 23px/800, 한 줄 고정 `white-space:nowrap`)
- **마이크 버튼(주인공)**: 192×192px 원형, 초록 그라데이션 `linear-gradient(170deg,#27924b,#1e7a3c 55%,#155c2c)`, 그림자 `0 10px 28px rgba(30,122,60,.38)` + 상단 inset 하이라이트. 흰색 SVG 마이크 아이콘 64px + "눌러서 말하기" 25px/800. `:active`에서 `scale(.96)`
- 검색줄: 흰 input 카드(높이 52px, radius 16px, placeholder "품목 입력 (예: 사과, 갈치)") + 초록 입체 "검색" 버튼
- 카테고리: 2열 그리드(gap 10px), 5번째(건어물·특산품)는 `grid-column:1/-1` 전체 폭. 각 52px 높이, 흰 배경, 1.5px 테두리 #eae4d6, 이모지 22px + 18px/700 텍스트

### 화면 2 — 가게 선택
- 목적: 품목을 파는 가게 후보 중 목적지 선택
- 뒤로가기 칩(높이 44px pill) → 마스코트+말풍선("'사과' 파는 가게예요…", 품목명은 초록 강조) → 안내문 16px
- 가게 카드(흰색, radius 20px, 그림자, padding 16px):
  - 1행: 순위 원형 배지 36px(연초록 배경 #e3f0e6, 진초록 글자) / 가게 이름 24px/800 / 취급 태그(크림 배경, 15px)
  - 2행: **거리 칩(최우선 정보)** — 주황 연한 배경 #fdeadb, radius 14px 안에 "약 20m" 24px/900 주황 + "같은 층 · A030호" 16px/700 갈색(#b05a15). 두 span 모두 `white-space:nowrap` 필수(390px에서 줄바꿈 방지)
  - 우측 "안내 ▶" 초록 입체 버튼(52px 높이)
- 목록 끝 "아래로 밀어서 더 보기 ↓" 힌트 15px 회색

### 화면 3 — 네비게이션
- 목적: 차량 내비처럼 실내 경로 안내. 지도 전체 화면, 배경 #f1ecdf
- **상단 안내 바(크고 시원하게)**: radius 28px, padding 18px 20px, 초록 그라데이션. 좌측 64px 아이콘 박스(반투명 흰 배경, ⬆ 38px) + "30m 직진" 34px/900 + "다음에 오른쪽이에요" 18px/700 흰 85%
  - 도착 상태: 주황 그라데이션 + 🎉 + "도착했어요!" (mockup.html에 주석으로 포함)
- 안내 바 아래: 좌측 "← 다른 가게" "🏠 처음" 칩(44px, 반투명 흰) / 우측 📍(켜짐=초록 입체) 🔊(꺼짐=흰) 원형 토글 52px
- 하단: 층 이동 CTA "🚶 지하2층에 도착하면 누르세요" (64px, 주황 그라데이션) + 층 탭(흰 pill 컨테이너 안 2분할, 활성=초록 입체)
- 지도 오버레이: 목적지 점포(주황 테두리 3px + 연주황 배경 + 그림자), 주황 6px 점선 경로, 내 위치(초록 34px 점 + 흰 테두리 4px + 위쪽 시야 웨지)

### 화면 3-C — 네비게이션 C안: 2.5D 벡터 지도 (`mockup_nav_2.5d.html`)
지도를 PNG가 아닌 **벡터(SVG 트레이싱) 데이터**로 재작도했을 때의 목표 룩. 상단 안내 바·칩·토글·하단 층 이동 UI는 화면 3과 동일하고, 지도만 교체.

**2.5D 구현 원리 (CSS만으로):**
1. 지도 바닥판 `.map-plane` (460×780px) 하나에 `transform: perspective(1100px) rotateX(var(--map-tilt)) scale(1.26) translateY(-6px) translateX(-18px)` — 기울기는 토큰 `--map-tilt: 46deg` 하나로 제어
2. `.map-plane`과 모든 블록에 `transform-style: preserve-3d`, 라벨 `span`에 `transform: rotateX(calc(var(--map-tilt) * -1))` → **지도가 기울거나 회전해도 글자는 화면을 향해 바로 섬 (빌보드)**. 실제 구현에서 지도를 heading에 따라 rotateZ로 돌릴 때도 같은 원리로 라벨에 역회전을 주면 됨
3. 블록 "두께"는 `border-bottom` 8~9px 어두운 색 — 기울면 옆면처럼 보임 (진짜 3D 지오메트리 불필요)
4. 경로는 SVG `<path>` 3겹: 흰색 14px 밑줄 → 주황 8px `stroke-dasharray:2 16` 점선 → 화살표 머리 폴리곤

**권역 색 토큰:** 청과 `--zone-fruit-bg:#e6f0e8`(글자 #3e6b4c) / 수산 `--zone-fish-bg:#dde9f0`(글자 #3f6b85) / 통로 `--map-corridor:#fdfaf2` / 바닥판 `--map-plane:#f6f1e4` / 목적지는 공통 주황 토큰 사용

**실제 구현 시:** 블록·통로의 좌표(예: `left:28px;top:256px`)는 판매동 B1 SVG 트레이싱 데이터에서 생성. 이 목업의 좌표는 예시. app.js의 지도 렌더링을 건드리는 작업이므로 별도 트랙.

## Interactions & Behavior
목업은 정적이므로 아래는 의도 설명:
- 마이크 버튼: 누르면 음성 인식 시작 → 결과로 화면 2 이동. `:active` scale(.96)
- 검색/카테고리: 화면 2로 이동
- "안내 ▶": 화면 3으로 이동
- 화면 3 안내 바: 진행 중(초록) ↔ 도착(주황 `.instr.arrived`) 상태 교체
- 📍/🔊 토글: `.toggle.on`(초록) / `.toggle.off`(흰) 클래스 교체
- 층 탭: `.floor-tab.on/.off` 교체
- 복잡한 애니메이션 없음 (요구사항)

## State Management
- 화면 1→2: 검색 품목명(말풍선·카드 목록에 반영)
- 화면 2: 가게 목록(순위, 이름, 거리, 층, 호수, 태그) — 가까운 순 정렬
- 화면 3: 현재 안내 단계(직진/회전/도착), 위치추적·음성안내 on/off, 현재 층/목적지 층

## Design Tokens
`mockup.html`의 `:root`에 전부 CSS 변수로 정의되어 있음. 요약:
- 색상: `--green:#1e7a3c` `--green-dark:#155c2c` `--green-soft:#e3f0e6` `--orange:#e8731a` `--orange-soft:#fdeadb` `--cream:#faf6ee` `--card:#fff` `--ink:#232a24` `--ink-sub:#6b7268` `--line:#eae4d6`
- 글자: `--fs-body:19px`(최소) `--fs-sub:16px` `--fs-title:23px` `--fs-big:28px` `--fs-hero:34px`
- 간격: 8/12/16/20/24px 스케일, `--touch:52px`(최소 터치), `--radius:20px` `--radius-lg:28px`
- 그림자: `--shadow:0 4px 16px rgba(35,42,36,.08)`
- 입체 초록 버튼(내비 느낌): `--btn-green-grad` + `--btn-green-shadow` (그라데이션 + 위 하이라이트/아래 음영 inset)
- 폰트: Pretendard Variable (CDN: `cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css`), fallback `-apple-system, 'Noto Sans KR', sans-serif`

## Assets
- 마스코트 무농이/신선이 이미지: 사용자 보유 — placeholder(`.mascot`) 교체 필요
- 평면도 PNG: 기존 서비스 보유 — 화면 3 지도 영역에 사용
- 마이크 아이콘: 인라인 SVG (mockup.html 안에 포함, 별도 파일 없음)
- 그 외 아이콘은 전부 이모지 (📍🔍🍎🥬🐟🥩🦑⬆🎉🏠🔊🚶▶)

## Files
- `mockup.html` — 정적 HTML+CSS 목업 (기준)
- `mockup_nav_2.5d.html` — 화면 3 C안: 2.5D 벡터 지도 네비게이션 목업
- `가락몰 길찾기 리디자인.dc.html` — 디자인 툴 원본 (참고용)
