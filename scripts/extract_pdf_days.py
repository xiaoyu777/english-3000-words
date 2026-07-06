import json
import re
from pathlib import Path

from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[1]
PDF = ROOT / "【高考拔高】3000词.pdf"
OUT = ROOT / "data"


DAY_RE = re.compile(r"【Day\s+(\d+)】考纲第(\d+)-(\d+)词")
NO_LINE_RE = re.compile(r"^(\d+)\.(.+)$")
TARGET_OVERRIDES = {
    1234: "likes",
    2073: "swings",
    2829: "tends",
    2898: "cheeseburger",
}


def clean_text(text: str) -> str:
    text = text.replace("\x00", "")
    text = text.replace("\u3000", " ").replace("\xa0", " ")
    for bad, good in {
        "嫿": "计",
        "⬀": "客",
        "⬂": "室",
        "⬁": "宣",
        "⫾": "宠",
    }.items():
        text = text.replace(bad, good)
    text = re.sub(r"北京⼤学在读.*", "", text)
    text = re.sub(r"/\d+191", "", text)
    text = re.sub(r"^[&=·>\\-mT S]+$", "", text, flags=re.M)
    return text


def first_cjk_index(s: str) -> int:
    for i, ch in enumerate(s):
        if "\u4e00" <= ch <= "\u9fff" or ch in "（，。；：？！、":
            return i
    return -1


def normalize_spaces(s: str) -> str:
    s = re.sub(r"\s+", " ", s)
    s = s.replace(" ’", "’").replace(" '", "'").replace(" ,", ",").replace(" .", ".")
    s = s.replace("( ", "(").replace(" )", ")")
    return s.strip()


def strip_level(raw: str):
    raw = normalize_spaces(raw)
    stars = raw.count("*")
    level = 2 if stars >= 2 else 1 if stars == 1 else 0
    word = raw.replace("*", "").strip()
    prev = None
    while prev != word:
        prev = word
        word = re.sub(r"\s+(?:[-=&>·]+|[pPmMtTsS])$", "", word).strip()
    return word, level


def parse_word_list(day: int, text: str):
    start_no = (day - 1) * 100 + 1
    end_no = day * 100
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    words = []
    i = 0
    while i < len(lines):
        m = NO_LINE_RE.match(lines[i])
        if not m:
            i += 1
            continue
        no = int(m.group(1))
        if not (start_no <= no <= end_no):
            i += 1
            continue
        raw = m.group(2).strip()
        i += 1
        while i < len(lines) and not NO_LINE_RE.match(lines[i]):
            extra = lines[i].strip()
            if extra and not extra.startswith("【Day"):
                raw += " " + extra
            i += 1
        word, level = strip_level(raw)
        words.append({"no": no, "word": word, "level": level})
    return words


def split_entries(day: int, text: str):
    start_no = (day - 1) * 100 + 1
    end_no = day * 100
    entries = []
    for no in range(start_no, end_no + 1):
      pattern = rf"(?ms)(?:^|\n){no}\.(.*?)(?=(?:\n{no + 1}\.)|\Z)"
      m = re.search(pattern, text)
      if not m:
          entries.append(None)
          continue
      entries.append(m.group(1).strip())
    return entries


def normalize_entry(entry: str):
    entry = clean_text(entry)
    entry = re.sub(r"\n+", " ", entry)
    entry = normalize_spaces(entry)
    idx = first_cjk_index(entry)
    if idx < 0:
        return normalize_spaces(entry), ""
    en = normalize_spaces(entry[:idx])
    zh = normalize_spaces(entry[idx:])
    return en, zh


def gloss_from_zh(zh: str):
    parens = re.findall(r"（([^（）]{1,12})）", zh)
    if parens:
        return parens[0].strip()
    zh = zh.strip()
    if not zh:
        return ""
    # Keep fallback short enough for multiple-choice buttons.
    cut = re.split(r"[，。；：？！、]", zh, maxsplit=1)[0].strip()
    if len(cut) > 10:
        cut = cut[:10]
    return cut


def ensure_target_marker(en: str, no: int, word: str) -> str:
    if "(" in en and ")" in en:
        return en
    candidates = [TARGET_OVERRIDES.get(no), word]
    base = re.sub(r"\s*\(.*?\)", "", word).strip()
    if base and base != word:
        candidates.append(base)
    if base:
        candidates.extend([base + "s", base + "es", base[:-1] + "ies" if base.endswith("y") else ""])
    for target in [c for c in candidates if c]:
        pattern = re.compile(rf"\b{re.escape(target)}\b", re.IGNORECASE)
        if pattern.search(en):
            return pattern.sub(lambda m: "(" + m.group(0) + ")", en, count=1)
    raise SystemExit(f"Entry {no}: target word not marked and not found in sentence: {word} / {en}")


def js_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def render_day(day: int, words):
    start_no = (day - 1) * 100 + 1
    end_no = day * 100
    lines = [
        "/*",
        f" * 【高考拔高】3000词 —— Day {day} 数据（考纲第 {start_no}–{end_no} 词）",
        " * 自动从原书 PDF 提取；gloss 为便于选择题显示而从中文译文中程序化提取/压缩。",
        " */",
        "window.VOCAB_DATA = window.VOCAB_DATA || { days: {} };",
        f"window.VOCAB_DATA.days[{day}] = {{",
        f"  day: {day},",
        f"  title: {js_string(f'考纲第 {start_no}–{end_no} 词')},",
        "  words: [",
    ]
    for item in words:
        lines.append(
            "    { "
            f"no: {item['no']}, "
            f"word: {js_string(item['word'])}, "
            f"level: {item['level']}, "
            f"gloss: {js_string(item['gloss'])}, "
            f"en: {js_string(item['en'])}, "
            f"zh: {js_string(item['zh'])} "
            "},"
        )
    lines.extend(["  ]", "};", ""])
    return "\n".join(lines)


def main():
    reader = PdfReader(str(PDF))
    pages = [clean_text(page.extract_text() or "") for page in reader.pages]
    # The first PDF page is a table of contents that also lists all Day headers.
    # Real data starts at extracted page 6 with the Day 1 word list.
    full = "\n".join(pages[5:])
    matches = list(DAY_RE.finditer(full))
    if len(matches) != 30:
        raise SystemExit(f"Expected 30 Day headers, found {len(matches)}")

    all_days = {}
    report = []
    for idx, m in enumerate(matches):
        day = int(m.group(1))
        block = full[m.start(): matches[idx + 1].start() if idx + 1 < len(matches) else len(full)]
        start_no = (day - 1) * 100 + 1
        starts = [x.start() for x in re.finditer(rf"(?m)^{start_no}\.", block)]
        if len(starts) < 2:
            raise SystemExit(f"Day {day}: could not split word list and sentences")
        word_block = block[:starts[1]]
        sentence_block = block[starts[1]:]
        words = parse_word_list(day, word_block)
        entries = split_entries(day, sentence_block)
        if len(words) != 100:
            raise SystemExit(f"Day {day}: expected 100 words, got {len(words)}")
        merged = []
        for n, word in enumerate(words, start=start_no):
            entry = entries[n - start_no]
            if not entry:
                raise SystemExit(f"Day {day}: missing sentence entry {n}")
            en, zh = normalize_entry(entry)
            if not en or not zh:
                raise SystemExit(f"Day {day}: bad entry {n}: {entry[:80]}")
            en = ensure_target_marker(en, n, word["word"])
            merged.append({**word, "gloss": gloss_from_zh(zh), "en": en, "zh": zh})
        expected = list(range(start_no, start_no + 100))
        actual = [w["no"] for w in merged]
        if actual != expected:
            raise SystemExit(f"Day {day}: non-continuous numbers")
        all_days[day] = merged
        report.append((day, merged[0]["word"], merged[-1]["word"]))

    for day in range(2, 31):
        (OUT / f"day{day}.js").write_text(render_day(day, all_days[day]), encoding="utf-8")

    print(json.dumps({"days": len(all_days), "written": 29, "report": report}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
