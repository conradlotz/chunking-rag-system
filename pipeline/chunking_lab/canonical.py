"""Build the canonical hierarchical representation of a filing.

Input: parsed blocks and Item segments. Output: one canonical text (a
deterministic serialisation) and a document tree whose nodes carry stable
character offsets into it:

    document -> item -> section (nested headings) -> paragraph | table | list

Serialisation rules (normaliser version below):
* Unicode NFC; no-break and zero-width spaces normalised; whitespace collapsed.
* Characters outside the Basic Multilingual Plane replaced with U+FFFD so offsets
  agree between Python (code points), Postgres and JavaScript (UTF-16).
* Each heading and each block on its own, separated by a blank line.
* Tables serialised one row per line, cells joined with " | ".
"""

from __future__ import annotations

import re
import sys
import unicodedata
from dataclasses import dataclass

from chunking_lab.model import CanonicalDocument, Node
from chunking_lab.parse import PARSER, Block, ParsedFiling
from chunking_lab.tokenize import Tokenizer
from chunking_lab.versions import ComponentVersion

SEPARATOR = "\n\n"
MAX_HEADING_CHARS = 400
MAX_HEADING_LEVELS = 3

_ABBREVIATIONS = {
    "inc", "corp", "co", "ltd", "llc", "plc", "no", "nos", "vs", "etc", "e.g", "i.e", "mr", "mrs", "ms", "dr",
    "st", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "approx", "fig",
    "u.s", "u.k", "u.s.a", "n.a", "s.a", "n.v", "a.g", "dept", "est", "gov", "jr", "sr", "op", "ref", "sec",
}
_SENTENCE_END = re.compile(r"[.!?][\"'”’)\]]*\s+(?=[\"'“‘(\[]?[A-Z0-9$•])")
_ITEM_REF = re.compile(r"\bitem\s+\d{1,2}[a-c]?$", re.I)

NORMALIZER = ComponentVersion(
    "normalizer",
    "nfc-ws-bmp-tree",
    "1.0.0",
    params={
        "separator": "\\n\\n",
        "table_cell_joiner": " | ",
        "heading_rule": "fully bold/underlined/italic-bold block <= 400 chars, levels by first-seen style per item",
        "max_heading_levels": MAX_HEADING_LEVELS,
        "sentencer": "regex-abbrev-v1",
    },
    modules=(sys.modules[__name__],),
)


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"[     ]", " ", text)
    text = re.sub(r"[​‌‍⁠﻿­]", "", text)
    text = "".join(ch if ord(ch) <= 0xFFFF else "�" for ch in text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    return text.strip()


def split_sentences(text: str) -> list[int]:
    """Sentence start offsets within ``text`` (always includes 0)."""
    starts = [0]
    for m in _SENTENCE_END.finditer(text):
        before = text[: m.start() + 1]
        word = re.search(r"([\w.]+)\.$", before)
        if word and word.group(1).lower().rstrip(".") in _ABBREVIATIONS:
            continue
        if word and len(word.group(1)) == 1 and word.group(1).isupper():
            continue  # initials such as "J. Smith"
        if _ITEM_REF.search(before[:-1]):
            continue  # "see Item 1A. Risk Factors"
        starts.append(m.end())
    return starts


def _heading_style(block: Block) -> tuple | None:
    if block.kind != "text" or block.is_list or len(block.text) > MAX_HEADING_CHARS:
        return None
    if not (block.bold or block.underline):
        return None
    if len(block.text) < 3 or block.text.endswith(":") and len(block.text) > 120:
        return None
    return (block.underline, block.bold, block.italic, block.text.isupper(), block.centered)


@dataclass
class _Open:
    ordinal: int
    level: int


def build_canonical(parsed: ParsedFiling, tokenizer: Tokenizer) -> tuple[CanonicalDocument, dict]:
    parts: list[str] = []
    pos = 0
    raw_nodes: list[dict] = []

    def emit(text: str) -> tuple[int, int]:
        nonlocal pos
        if parts:
            parts.append(SEPARATOR)
            pos += len(SEPARATOR)
        parts.append(text)
        start = pos
        pos += len(text)
        return start, pos

    def add_node(**kw) -> int:
        kw["ordinal"] = len(raw_nodes)
        raw_nodes.append(kw)
        return kw["ordinal"]

    doc = add_node(parent=None, depth=0, node_type="document", start=0, end=0, item=None, heading=None, path=())
    diagnostics = {"headings": 0, "paragraphs": 0, "tables": 0, "lists": 0}

    for seg in parsed.items:
        title = normalize(seg.title)
        heading_text = normalize(" ".join(parsed.blocks[i].text for i in range(*seg.heading_blocks)))
        if title and title not in heading_text:
            heading_text = f"{heading_text} {title}"
        start, end = emit(heading_text)
        item_node = add_node(parent=doc, depth=1, node_type="item", start=start, end=end, item=seg.item,
                             heading=heading_text, path=(heading_text,))
        stack = [_Open(item_node, 0)]
        levels: dict[tuple, int] = {}

        for idx in range(*seg.body):
            block = parsed.blocks[idx]
            text = normalize(block.text)
            if not text:
                continue
            style = _heading_style(block)
            if style is not None:
                if style not in levels:
                    levels[style] = min(len(levels) + 1, MAX_HEADING_LEVELS)
                level = levels[style]
                while len(stack) > 1 and stack[-1].level >= level:
                    stack.pop()
                parent = stack[-1].ordinal
                s, e = emit(text)
                node = add_node(parent=parent, depth=raw_nodes[parent]["depth"] + 1, node_type="section", start=s,
                                end=e, item=seg.item, heading=text, path=raw_nodes[parent]["path"] + (text,))
                stack.append(_Open(node, level))
                diagnostics["headings"] += 1
                continue

            node_type = "table" if block.kind == "table" else ("list" if block.is_list else "paragraph")
            if node_type == "table":
                text = "\n".join(normalize(" | ".join(r)) for r in (block.rows or []))
                rel = [0] + [m.end() for m in re.finditer("\n", text)]
            else:
                rel = split_sentences(text)
            s, e = emit(text)
            parent = stack[-1].ordinal
            add_node(parent=parent, depth=raw_nodes[parent]["depth"] + 1, node_type=node_type, start=s, end=e,
                     item=seg.item, heading=None, path=raw_nodes[parent]["path"], sentences=tuple(s + r for r in rel))
            diagnostics[node_type + "s"] += 1

    text = "".join(parts)
    # Close spans: every container ends where its last descendant ends.
    for node in reversed(raw_nodes):
        if node["parent"] is not None:
            parent = raw_nodes[node["parent"]]
            parent["end"] = max(parent["end"], node["end"])
    raw_nodes[doc]["end"] = len(text)

    counts = tokenizer.count_batch([text[n["start"]:n["end"]] for n in raw_nodes])
    nodes = tuple(
        Node(
            ordinal=n["ordinal"], parent=n["parent"], depth=n["depth"], node_type=n["node_type"], start=n["start"],
            end=n["end"], token_count=c, item=n["item"], heading=n["heading"], heading_path=n["path"],
            sentence_starts=n.get("sentences"),
        )
        for n, c in zip(raw_nodes, counts, strict=True)
    )
    canonical = CanonicalDocument(
        text=text,
        nodes=nodes,
        items=tuple(seg.item for seg in parsed.items),
        token_count=counts[doc],
        parser_version=PARSER.id,
        normalizer_version=NORMALIZER.id,
        tokenizer_version=tokenizer.version.id,
    )
    diagnostics["sentences"] = sum(len(n.sentence_starts or ()) for n in nodes)
    diagnostics["nodes"] = len(nodes)
    return canonical, diagnostics


def heading_spans(doc: CanonicalDocument) -> list[tuple[int, int, int]]:
    """(start, end, node ordinal) of every item and section heading line."""
    spans = []
    for node in doc.nodes:
        if node.heading and node.node_type in ("item", "section"):
            spans.append((node.start, node.start + len(node.heading), node.ordinal))
    return spans
