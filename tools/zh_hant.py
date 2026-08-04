#!/usr/bin/env python3
"""Regenerate the Traditional Chinese (zh-Hant) column from the Simplified one.

Conversion = OpenCC s2twp (Taiwan standard + Taiwan/HK idioms) followed by a
hand-maintained vocabulary table for hotel wording.  Entries carrying
"hant_manual": true are left untouched.

    pip install opencc-python-reimplemented
    python3 tools/zh_hant.py                  # rewrite data/i18n.json
    python3 tools/zh_hant.py --dry-run        # show what would change
    python3 tools/zh_hant.py --fill-missing   # fill only empty zh-Hant (used in CI)
"""

import collections
import json
import re
import os
import sys

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
MEM_FILE = os.path.join(DATA, "i18n.json")

# Applied in order, after the OpenCC pass.
VOCAB = [
    ("客房與裝置", "客房與設備"),
    ("客房裝置", "客房設備"),
    ("裝置與備品", "設備與備品"),
    ("裝置", "設備"),
    ("各專案細節", "各案細節"),
    ("專案", "案件"),
    ("酒店", "飯店"),
    ("信息", "資訊"),
    ("預定", "預訂"),
    ("網絡", "網路"),
    ("公交", "公車"),
    ("大堂", "大廳"),
    ("前臺", "櫃台"),
    ("前台", "櫃台"),
    ("日元", "日圓"),
    ("運營業績", "營運實績"),
    ("運營公司", "營運公司"),
    ("運營中", "營運中"),
    ("運營", "營運"),
    ("智慧馬桶", "免治馬桶"),
    ("智慧型馬桶", "免治馬桶"),
    ("洗漱用品", "盥洗用品"),
    ("寄存", "寄放"),
    ("崗位", "職務"),
    ("出租車", "計程車"),
    ("視頻", "影片"),
    ("無線網絡", "無線網路"),
    ("高峰", "尖峰"),
    ("許可權", "權限"),
    ("諮詢視窗", "諮詢窗口"),
    ("瀏覽器型別", "瀏覽器類型"),
    ("客房型別", "客房類型"),
    ("型別", "類型"),
    ("個人資訊", "個人資料"),
    ("護照資訊", "護照資料"),
    ("統計資訊", "統計資料"),
    ("服務質量", "服務品質"),
    ("質量", "品質"),
    ("未經授權的訪問", "未經授權的存取"),
    ("訪問記錄", "存取紀錄"),
    ("訪問日誌", "造訪日誌"),
    ("訪問分析", "造訪分析"),
    ("訪問日期時間", "造訪日期時間"),
    ("訪問時的", "造訪時的"),
    ("訪問", "造訪"),
    ("合同", "合約"),
    ("節假日", "國定假日"),
    ("板塊", "區塊"),
    ("招聘應聘", "招募應徵"),
    ("招聘", "招募"),
    ("應聘", "應徵"),
    ("選拔", "選才"),
    ("篡改", "竄改"),
    ("丟失", "遺失"),
    ("洩露", "洩漏"),
    ("公佈", "公布"),
    ("IP地址", "IP位址"),
    ("內部規程", "內部規範"),
    ("電子郵箱地址", "電子郵件地址"),
    ("身份", "身分"),
    ("住宿套餐", "住宿方案"),
    ("禁用", "停用"),
    ("大廈", "大樓"),
]


def convert(text, cc):
    out = cc.convert(text)
    for a, b in VOCAB:
        out = out.replace(a, b)
    # Taiwan typography: curly double quotes -> corner brackets
    out = re.sub("\u201c([^\u201c\u201d]{1,40})\u201d", "\u300c\\1\u300d", out)
    return out


def main():
    dry = "--dry-run" in sys.argv
    # --fill-missing: 空欄だけを埋める。既存の訳には触らない（CI から呼ぶときはこれ）
    fill_only = "--fill-missing" in sys.argv
    try:
        import opencc
    except ImportError:
        sys.exit("需要先安装：pip install opencc-python-reimplemented")
    cc = opencc.OpenCC("s2twp")

    with open(MEM_FILE, encoding="utf-8") as f:
        mem = json.load(f, object_pairs_hook=collections.OrderedDict)

    changed = skipped = 0
    for entry in mem.values():
        if entry.get("hant_manual"):
            skipped += 1
            continue
        zh = entry.get("zh", "")
        if not zh:
            continue
        if fill_only and entry.get("zh-Hant"):
            skipped += 1
            continue
        new = convert(zh, cc)
        if new != entry.get("zh-Hant"):
            changed += 1
            if dry:
                print("-", entry.get("zh-Hant", "")[:60])
                print("+", new[:60], "\n")
        entry["zh-Hant"] = new

    if dry:
        print(f"would update {changed} entries, {skipped} manual entries skipped")
        return

    with open(MEM_FILE, "w", encoding="utf-8") as f:
        json.dump(mem, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"updated {changed} entries, {skipped} manual entries skipped")


if __name__ == "__main__":
    main()
