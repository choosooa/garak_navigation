#!/usr/bin/env python3
# 생성일: 2026-06-25
# 공공데이터포털 "서울시농수산식품공사_가락몰 시설정보" CSV → 우리 stores.json 변환기
#
# 출처: https://www.data.go.kr/data/15156388/fileData.do  (CSV, 약 1,142개 점포)
# 공식 제공 컬럼(설명 기준): 연번 / 상호명 / 활동장소 / 건물명 / 연락처 / 취급부류
#   - 활동장소 예: "가락몰 5관 편의시설 1층 001-1호"  → 건물 / 층 / 호수 파싱
#   - 취급부류 예: "채소류", "수산부류", "기타" 등        → categories 매핑
#
# 주의:
#  1) 이 데이터에는 평면도 x,y 좌표가 없습니다. x,y 는 비워둔 채(null) 출력하고,
#     admin-map.html(좌표 매핑 도구)로 채우세요.
#  2) 실제 CSV 헤더가 아래 COLS 와 다르면 COLS 매핑만 고쳐 주세요(코드 본문은 그대로).
#  3) 공공데이터 CSV 는 인코딩이 cp949(euc-kr)인 경우가 많아 자동 감지합니다.
#
# 사용법:
#   python3 tools/convert_garak_csv.py <받은_CSV_경로> > stores.json
#   예) python3 tools/convert_garak_csv.py ~/Downloads/가락몰_시설정보.csv > stores.json
#   구역 파일도 함께 만들려면: --zones zones.json (기존 zones.json 의 좌표는 유지·병합)

import sys, csv, json, re, io, os

# ── 실제 CSV 헤더명에 맞춰 조정하는 부분 (핵심) ───────────────────
# ※ 이 CSV는 위치정보가 '건물명' 컬럼에 들어있음
#   예: "가락몰 판매동 청과부류 지하1층 001-1호"  → 시설명 / 층 / 호수
COLS = {
    "name":     ["상호명", "시설명", "점포명"],
    "place":    ["건물명", "활동장소", "주소"],   # 위치 원천 = 건물명 컬럼
    "tel":      ["대표번호", "연락처", "전화번호"],
    "category": ["취급부류", "취급품목", "부류"],
}

# 취급부류(원문) → 우리 앱 카테고리 동의어 매핑 (부분일치, 위에서부터 먼저 매칭)
CATEGORY_MAP = {
    "청과":   ["청과", "과일"],
    "과일":   ["과일", "청과"],
    "채소":   ["채소"],
    "나물":   ["채소", "나물"],
    "조미채": ["채소"],
    "수산":   ["수산"],
    "선어":   ["수산", "생선"],
    "패류":   ["수산", "패류"],
    "갑각":   ["수산", "갑각류"],
    "젓갈":   ["수산", "젓갈"],
    "축산":   ["축산", "정육"],
    "건어":   ["건어물", "팔도특산품"],
    "건해":   ["건어물", "팔도특산품"],
    "양곡":   ["양곡"],
    "식품잡화": ["식품잡화"],
    "식자재": ["식자재"],
    "특산":   ["팔도특산품"],
    "회":     ["회", "회센터"],
}


def read_rows(path):
    """cp949 → utf-8 순으로 인코딩을 시도해 CSV 행(dict)을 읽는다."""
    for enc in ("utf-8-sig", "cp949", "euc-kr", "utf-8"):
        try:
            with open(path, "r", encoding=enc, newline="") as f:
                return list(csv.DictReader(f)), enc
        except (UnicodeDecodeError, LookupError):
            continue
    raise SystemExit("CSV 인코딩을 인식하지 못했습니다.")


def pick(row, keys):
    """후보 헤더명 중 실제 존재하는 컬럼의 값을 반환."""
    for k in keys:
        if k in row and row[k] not in (None, ""):
            return row[k].strip()
    return ""


def parse_floor(place):
    """'... 1층 ...' / '지하 1층' → 정수 층(지하는 음수)."""
    m = re.search(r"지하\s*(\d+)\s*층", place)
    if m:
        return -int(m.group(1))
    m = re.search(r"(\d+)\s*층", place)
    return int(m.group(1)) if m else None


def parse_zone(place):
    """'... 001-1호' → '001-1호' (마지막 호수 토큰)."""
    m = re.search(r"([0-9A-Za-z\-]+호)", place)
    return m.group(1) if m else ""


# 건물 정규화: 위치 문자열은 '건물 + 용도구분(section)'이 붙어 있음
#   예: '가락몰 판매동 청과부류 지하1층 001-1호' → building='가락몰 판매동', section='청과부류'
#   평면도 동코드 대응: 판매동=G, 1관=E, 2관=C, 3관=D, 4관=B, 5관=A, 업무동=F (admin-map.html dongOf)
BUILDINGS = ["판매동", "1관", "2관", "3관", "4관", "5관", "업무동"]


def parse_building(row, place):
    """건물명 문자열에서 층 토큰 앞부분을 building/section 으로 분리.
    '가락몰판매동기타' 처럼 띄어쓰기 없는 표기도 처리."""
    head = re.split(r"\s*(?:지하\s*\d+\s*층|\d+\s*층)", place)[0].strip()
    h = head.replace("가락몰", "", 1).strip()
    for b in BUILDINGS:
        if h.startswith(b):
            section = h[len(b):].strip()
            return f"가락몰 {b}", section
    return head or place, ""   # 못 알아본 표기는 원문 유지


def map_categories(raw):
    """취급부류 문자열 → 카테고리 배열. 매핑에 없으면 원문 그대로 1개."""
    if not raw:
        return []
    for key, cats in CATEGORY_MAP.items():
        if key in raw:
            return cats
    return [raw]


def floor_label(f):
    return f"지하{-f}층" if f < 0 else f"{f}층"


def build_zones(stores, prev_path=None):
    """매장을 (building, section, floor)로 묶어 구역 목록 생성.
    prev_path 의 기존 zones.json 에 같은 key 좌표가 있으면 유지(수작업 좌표 보존)."""
    prev = {}
    if prev_path and os.path.exists(prev_path):
        with open(prev_path, "r", encoding="utf-8") as f:
            for z in json.load(f).get("zones", []):
                if isinstance(z.get("x"), (int, float)) and isinstance(z.get("y"), (int, float)):
                    prev[z["key"]] = (z["x"], z["y"])

    groups = {}
    for s in stores:
        k = (s["building"], s["section"], s["floor"])
        groups[k] = groups.get(k, 0) + 1

    # 좌표 미지정 구역은 null — 임의 좌표를 넣으면 최근접 매장 계산을 오염시킴.
    # admin-map.html 에서 평면도 위에 클릭해 실좌표를 채우세요.
    zones = []
    for (b, sec, f), cnt in sorted(groups.items(), key=lambda kv: -kv[1]):
        key = f"{b}|{sec}|{f}"
        x, y = prev.get(key, (None, None))
        zones.append({
            "key": key,
            "building": b,
            "section": sec,
            "floor": f,
            "name": " ".join(t for t in (b, sec, floor_label(f)) if t),
            "count": cnt,
            "x": x,
            "y": y,
        })
    return zones


def main():
    if len(sys.argv) < 2:
        sys.exit("사용법: python3 tools/convert_garak_csv.py <CSV경로> [--zones zones.json] > stores.json")

    zones_path = None
    if "--zones" in sys.argv:
        zones_path = sys.argv[sys.argv.index("--zones") + 1]

    rows, enc = read_rows(sys.argv[1])
    sys.stderr.write(f"[info] 인코딩={enc}, 행수={len(rows)}\n")

    # 기존 stores.json 에 수작업 좌표(x,y)가 있으면 id 기준으로 보존
    prev_xy = {}
    if os.path.exists("stores.json"):
        with open("stores.json", encoding="utf-8") as f:
            for s in json.load(f).get("stores", []):
                if isinstance(s.get("x"), (int, float)) and isinstance(s.get("y"), (int, float)):
                    prev_xy[s["id"]] = (s["x"], s["y"])

    stores = []
    for i, row in enumerate(rows, start=1):
        name = pick(row, COLS["name"])
        if not name:
            continue
        place = pick(row, COLS["place"])
        floor = parse_floor(place)
        building, section = parse_building(row, place)
        sid = f"s{i:04d}"
        x, y = prev_xy.get(sid, (None, None))
        stores.append({
            "id": sid,
            "name": name,
            "building": building,
            "section": section,
            "zone": parse_zone(place),
            "floor": floor if floor is not None else 1,   # 층 못 읽으면 1층 가정
            "categories": map_categories(pick(row, COLS["category"])),
            "tel": pick(row, COLS["tel"]),
            # x, y 는 좌표 매핑 도구(admin-map.html)로 채울 것 — 기존 좌표는 보존
            "x": x,
            "y": y,
        })

    out = {
        "_comment": "가락몰 시설정보(공공데이터포털) → 변환됨. x,y 는 admin-map.html 로 채우세요.",
        "_source": "https://www.data.go.kr/data/15156388/fileData.do",
        "stores": stores,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    sys.stderr.write(f"[done] 매장 {len(stores)}개 변환 완료. x,y 는 좌표 매핑 도구로 입력하세요.\n")

    if zones_path:
        zones = build_zones(stores, prev_path=zones_path)
        zout = {
            "_comment": "구역(building+section+층) 대표좌표. ⚠️ 자동배치 좌표는 임의값 — admin-map.html 에서 공식 평면도 위에 클릭해 실제 위치로 교체하세요.",
            "zones": zones,
        }
        with open(zones_path, "w", encoding="utf-8") as f:
            json.dump(zout, f, ensure_ascii=False, indent=2)
        sys.stderr.write(f"[done] 구역 {len(zones)}개 → {zones_path}\n")


if __name__ == "__main__":
    main()
