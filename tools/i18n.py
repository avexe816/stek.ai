#!/usr/bin/env python3
"""Translation-memory core for ELE HOTEL.

Design (v1.5)
-------------
* Japanese is the ONLY authored language. Every string in data/*.json is Japanese.
* data/i18n.json is the translation memory:
      "<key>": {"ja": "...", "zh": "...", "en": "...", "ko": "", "th": "", "locked": true}
  key = first 16 hex chars of sha1(ja text). When one Japanese string needs two
  different translations in two places, the second one gets a path-scoped entry
  keyed on sha1(path + "|" + ja) and carries a "path" field.
* At build time each Japanese string is resolved through the memory for the
  target language. Missing translation -> falls back to the Japanese text and is
  reported, so nothing ever renders blank.
* "locked": true marks copy that a human wrote (brand voice, hero, positioning).
  Locked entries must never be replaced by machine translation.
* A stored translation always wins. Only for strings that are NOT in the memory
  does the script heuristic decide what happens: text containing Japanese script
  (kana / kanji / CJK punctuation) is reported as a translation gap, anything
  else is treated as language-neutral and passed through untouched -- brand
  names, "TOKYO / NAGOYA / OSAKA / SENDAI", dates, "NEW OPEN" and so on.
"""

import hashlib
import json
import os
import re

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
MEM_FILE = os.path.join(DATA, "i18n.json")

# Hiragana, Katakana, CJK ideographs, CJK punctuation, full-width forms
JP_RE = re.compile(
    r"[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3000-\u303f\uff01-\uff60\u3005\u30fc]"
)


def needs_translation(s):
    return isinstance(s, str) and bool(JP_RE.search(s))


def key_of(s):
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:16]


def path_key(path, s):
    return hashlib.sha1((path + "|" + s).encode("utf-8")).hexdigest()[:16]


def load_memory():
    if not os.path.exists(MEM_FILE):
        return {}
    with open(MEM_FILE, encoding="utf-8") as f:
        return json.load(f)


def save_memory(mem):
    with open(MEM_FILE, "w", encoding="utf-8") as f:
        json.dump({k: mem[k] for k in sorted(mem, key=lambda x: mem[x]["ja"])}, f,
                  ensure_ascii=False, indent=2)
        f.write("\n")


class Resolver:
    """Resolve Japanese strings into a target language, recording gaps."""

    def __init__(self, mem=None):
        self.mem = mem if mem is not None else load_memory()
        self.missing = {}   # lang -> {key: {"ja":..., "path":...}}
        self.used = set()

    def text(self, s, lang, path=""):
        if not isinstance(s, str):
            return s
        if lang == "ja":
            return s
        pk = path_key(path, s) if path else None
        for k in ([pk] if pk and pk in self.mem else []) + [key_of(s)]:
            self.used.add(k)
            entry = self.mem.get(k)
            if entry and entry.get(lang):
                return entry[lang]
        if not needs_translation(s):
            return s  # language-neutral (latin text, numbers, dates)
        self.missing.setdefault(lang, {})[key_of(s)] = {"ja": s, "path": path}
        return s  # graceful fallback: show Japanese rather than nothing

    def tree(self, node, lang, path=""):
        """Deep-copy a data tree, translating every string into `lang`."""
        if isinstance(node, str):
            return self.text(node, lang, path)
        if isinstance(node, list):
            return [self.tree(v, lang, f"{path}[{i}]") for i, v in enumerate(node)]
        if isinstance(node, dict):
            return {k: self.tree(v, lang, f"{path}.{k}") for k, v in node.items()}
        return node

    def report(self):
        return {lg: len(d) for lg, d in self.missing.items() if d}
