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

import sys, csv, json, re, io

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


def parse_building(row, place):
    """건물명 문자열에서 층 토큰 앞부분(시설명)을 건물로 사용.
    예: '가락몰 판매동 청과부류 지하1층 001-1호' → '가락몰 판매동 청과부류'."""
    head = re.split(r"\s*(?:지하\s*\d+\s*층|\d+\s*층)", place)[0].strip()
    return head or place


def map_categories(raw):
    """취급부류 문자열 → 카테고리 배열. 매핑에 없으면 원문 그대로 1개."""
    if not raw:
        return []
    for key, cats in CATEGORY_MAP.items():
        if key in raw:
            return cats
    return [raw]


def main():
    if len(sys.argv) < 2:
        sys.exit("사용법: python3 tools/convert_garak_csv.py <CSV경로> > stores.json")

    rows, enc = read_rows(sys.argv[1])
    sys.stderr.write(f"[info] 인코딩={enc}, 행수={len(rows)}\n")

    stores = []
    for i, row in enumerate(rows, start=1):
        name = pick(row, COLS["name"])
        if not name:
            continue
        place = pick(row, COLS["place"])
        floor = parse_floor(place)
        stores.append({
            "id": f"s{i:04d}",
            "name": name,
            "building": parse_building(row, place),
            "zone": parse_zone(place),
            "floor": floor if floor is not None else 1,   # 층 못 읽으면 1층 가정
            "categories": map_categories(pick(row, COLS["category"])),
            "tel": pick(row, COLS["tel"]),
            # x, y 는 좌표 매핑 도구(admin-map.html)로 채울 것 — 우선 null
            "x": None,
            "y": None,
        })

    out = {
        "_comment": "가락몰 시설정보(공공데이터포털) → 변환됨. x,y 는 admin-map.html 로 채우세요.",
        "_source": "https://www.data.go.kr/data/15156388/fileData.do",
        "stores": stores,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    sys.stderr.write(f"[done] 매장 {len(stores)}개 변환 완료. x,y 는 좌표 매핑 도구로 입력하세요.\n")


if __name__ == "__main__":
    main()
