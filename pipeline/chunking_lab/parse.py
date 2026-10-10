"""Parse SEC 10-K HTML (including inline XBRL) into styled text blocks and
locate the in-scope Items.

The parser keeps visible text only, records the styling needed to recognise
headings (bold, italic, underline, centred), turns tables into rows of cells,
and drops page furniture (page numbers, running headers, "Table of Contents"
links).
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field

import lxml.html

from chunking_lab.versions import ComponentVersion

IN_SCOPE_ITEMS = ("1", "1A", "7", "7A")
MIN_ITEM_CHARS = 1500

BLOCK_TAGS = frozenset(
    {"p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
     "body", "center", "blockquote", "dl", "dt", "dd", "pre", "hr"}
)
SKIP_TAGS = frozenset({"script", "style", "head", "title", "noscript"})
ITEM_ORDER = ("1", "1A", "1B", "1C", "2", "3", "4", "5", "6", "7", "7A", "8", "9", "9A", "9B", "9C",
              "10", "11", "12", "13", "14", "15", "16")
ITEM_RE = re.compile(r"^\s*item\s*(\d{1,2}\s?[abc]?)\s*(?:[\.:\-–—]\s*|\s+|$)(.*)$", re.I | re.S)
BULLETS = frozenset("•●◦▪■-–—·o")
PAGE_FURNITURE = [
    re.compile(r"^\s*(page\s*)?[-–—]?\s*\d{1,3}\s*[-–—]?\s*$", re.I),
    re.compile(r"^\s*table\s+of\s+contents\s*$", re.I),
    re.compile(r"^\s*[ivxlc]{1,6}\s*$", re.I),
    re.compile(r"^.{0,120}\b(form\s+10-?k|annual\s+report)\b.{0,40}\|\s*\d{1,3}\s*$", re.I),
    re.compile(r"^.{0,120}\|\s*\d{1,3}\s*$"),
]

PARSER = ComponentVersion(
    "parser",
    "sec-10k-html",
    "1.0.0",
    params={"items": list(IN_SCOPE_ITEMS), "min_item_chars": MIN_ITEM_CHARS, "toc_rule": "max-gap"},
    modules=(sys.modules[__name__],),
)


@dataclass
class Block:
    kind: str  # "text" | "table"
    text: str
    bold: bool = False
    italic: bool = False
    underline: bool = False
    centered: bool = False
    is_list: bool = False
    in_table: bool = False
    rows: list[list[str]] | None = None


@dataclass
class ItemSegment:
    item: str
    title: str
    heading_blocks: tuple[int, int]  # [start, end) block indices of the heading
    body: tuple[int, int]  # [start, end) block indices of the body


@dataclass
class ParsedFiling:
    blocks: list[Block]
    items: list[ItemSegment]
    dei: dict = field(default_factory=dict)
    diagnostics: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# HTML -> blocks
# ---------------------------------------------------------------------------


def _local(tag) -> str:
    if not isinstance(tag, str):
        return ""
    tag = tag.lower()
    return tag.rsplit(":", 1)[-1] if ":" in tag else tag.rsplit("}", 1)[-1]


def _style(el) -> str:
    return (el.get("style") or "").lower().replace(" ", "")


def _hidden(el) -> bool:
    if "display:none" in _style(el):
        return True
    return isinstance(el.tag, str) and el.tag.lower() == "ix:header"


class _Run:
    __slots__ = ("text", "bold", "italic", "underline")

    def __init__(self, text: str, bold: bool, italic: bool, underline: bool) -> None:
        self.text, self.bold, self.italic, self.underline = text, bold, italic, underline


class _BlockBuilder:
    def __init__(self) -> None:
        self.blocks: list[Block] = []
        self.runs: list[_Run] = []
        self.centered = False
        self.is_list = False

    def add(self, text: str | None, bold: bool, italic: bool, underline: bool) -> None:
        if text:
            self.runs.append(_Run(text, bold, italic, underline))

    def flush(self) -> None:
        text = "".join(r.text for r in self.runs)
        clean = _ws(text)
        if clean:
            styled = [r for r in self.runs if r.text.strip()]
            self.blocks.append(
                Block(
                    "text",
                    clean,
                    bold=all(r.bold for r in styled),
                    italic=all(r.italic for r in styled),
                    underline=all(r.underline for r in styled),
                    centered=self.centered,
                    is_list=self.is_list or clean[0] in BULLETS and len(clean) > 2 and clean[1] == " ",
                )
            )
        self.runs = []


def _ws(text: str) -> str:
    return re.sub(r"[\s   ​﻿]+", " ", text).strip()


def _flags(el, bold: bool, italic: bool, underline: bool) -> tuple[bool, bool, bool]:
    tag = _local(el.tag)
    style = _style(el)
    if tag in ("b", "strong") or re.search(r"font-weight:(bold|[6-9]00)", style):
        bold = True
    if re.search(r"font-weight:(normal|[1-4]00)", style):
        bold = False
    if tag in ("i", "em") or "font-style:italic" in style:
        italic = True
    if tag == "u" or "text-decoration:underline" in style or "text-decoration-line:underline" in style:
        underline = True
    return bold, italic, underline


def _table_rows(table) -> list[list[str]]:
    rows = []
    for tr in table.iter():
        if _local(tr.tag) != "tr":
            continue
        cells = []
        for cell in tr:
            if _local(cell.tag) not in ("td", "th") or _hidden(cell):
                continue
            text = _ws("".join(cell.itertext()))
            if text:
                cells.append(text)
        cells = _merge_cells(cells)
        if cells:
            rows.append(cells)
    return rows


def _merge_cells(cells: list[str]) -> list[str]:
    """Join currency symbols, closing parentheses and percent signs to their numbers."""
    merged: list[str] = []
    for cell in cells:
        if merged and cell in (")", "%", ")%", "pts", "bps") or merged and merged[-1] in ("$", "(", "$(", "€", "£"):
            merged[-1] += cell
        else:
            merged.append(cell)
    return merged


def _walk(el, out: _BlockBuilder, bold: bool, italic: bool, underline: bool, centered: bool) -> None:
    tag = _local(el.tag)
    if not tag or tag in SKIP_TAGS or _hidden(el):
        return
    b, i, u = _flags(el, bold, italic, underline)
    style = _style(el)
    c = centered or "text-align:center" in style or tag == "center" or (el.get("align") or "").lower() == "center"

    if tag == "table":
        out.flush()
        _emit_table(el, out, c)
        return
    if tag == "br":
        out.add("\n", b, i, u)
        return

    is_block = tag in BLOCK_TAGS
    if is_block:
        out.flush()
        out.centered = c
        out.is_list = tag == "li"
    out.add(el.text, b, i, u)
    for child in el:
        _walk(child, out, b, i, u, c)
        if child.tail:
            out.add(child.tail, b, i, u)
    if is_block:
        out.flush()
        out.centered = centered
        out.is_list = False


def _emit_table(table, out: _BlockBuilder, centered: bool) -> None:
    rows = _table_rows(table)
    if not rows:
        return
    # Layout tables used for bullets: [bullet, text] per row.
    if all(len(r) <= 2 for r in rows) and all(r[0] in BULLETS for r in rows if len(r) == 2) and any(
        len(r) == 2 for r in rows
    ):
        for r in rows:
            out.blocks.append(Block("text", r[-1], is_list=True, in_table=True))
        return
    # Single-cell tables are text boxes.
    if len(rows) == 1 and len(rows[0]) == 1:
        out.blocks.append(Block("text", rows[0][0], centered=centered, in_table=True))
        return
    text = "\n".join(" | ".join(r) for r in rows)
    out.blocks.append(Block("table", text, rows=rows, in_table=True))


def _is_furniture(block: Block) -> bool:
    return block.kind == "text" and len(block.text) <= 160 and any(p.match(block.text) for p in PAGE_FURNITURE)


def _dei(root) -> dict:
    wanted = {
        "dei:documentfiscalyearfocus": "fiscal_year_focus",
        "dei:documentperiodenddate": "period_end",
        "dei:entityregistrantname": "registrant",
        "dei:documenttype": "document_type",
    }
    found = {}
    for el in root.iter():
        if _local(el.tag) != "nonnumeric":
            continue
        name = (el.get("name") or "").lower()
        if name in wanted and wanted[name] not in found:
            found[wanted[name]] = _ws("".join(el.itertext()))
    return found


def extract_blocks(body: bytes) -> tuple[list[Block], dict]:
    parser = lxml.html.HTMLParser(encoding="utf-8", remove_comments=True, huge_tree=True)
    root = lxml.html.fromstring(body, parser=parser)
    dei = _dei(root)  # read before hidden elements are skipped: DEI facts often sit in ix:header
    out = _BlockBuilder()
    body_el = root.find(".//body")
    _walk(body_el if body_el is not None else root, out, False, False, False, False)
    out.flush()
    blocks = [b for b in out.blocks if not _is_furniture(b)]
    return blocks, dei


# ---------------------------------------------------------------------------
# Item segmentation
# ---------------------------------------------------------------------------


def _item_key(raw: str) -> str | None:
    key = raw.replace(" ", "").upper()
    return key if key in ITEM_ORDER else None


def _candidates(blocks: list[Block]) -> list[tuple[int, str, str]]:
    found = []
    for idx, block in enumerate(blocks):
        # Some issuers put an Item heading in a short, single-row layout table.
        # Long tables (including tables of contents) remain ineligible.
        if len(block.text) > 300 or block.is_list:
            continue
        if block.kind == "table" and (not block.rows or len(block.rows) != 1):
            continue
        if block.kind not in ("text", "table"):
            continue
        m = ITEM_RE.match(block.text)
        if not m:
            continue
        key = _item_key(m.group(1))
        if key:
            found.append((idx, key, m.group(2).strip().lstrip("| ")))
    return found


def segment_items(blocks: list[Block]) -> tuple[list[ItemSegment], dict]:
    """Locate in-scope Items.

    The table of contents repeats every Item heading close together, so for each
    Item the heading followed by the most text before the next Item heading is
    taken as the real one.
    """
    cands = _candidates(blocks)
    lengths = [len(b.text) for b in blocks]
    prefix = [0]
    for n in lengths:
        prefix.append(prefix[-1] + n)

    def chars_between(a: int, b: int) -> int:
        return prefix[b] - prefix[a]

    best: dict[str, tuple[int, int, str]] = {}  # key -> (gap, block index, title)
    for pos, (idx, key, title) in enumerate(cands):
        nxt = cands[pos + 1][0] if pos + 1 < len(cands) else len(blocks)
        gap = chars_between(idx + 1, nxt)
        if key not in best or gap > best[key][0]:
            best[key] = (gap, idx, title)
    chosen = {key: (idx, title) for key, (_, idx, title) in best.items()}

    segments: list[ItemSegment] = []
    diagnostics = {"item_candidates": len(cands), "items_missing": [], "items_short": []}
    for key in IN_SCOPE_ITEMS:
        if key not in chosen:
            diagnostics["items_missing"].append(key)
            continue
        start, title = chosen[key]
        order = ITEM_ORDER.index(key)
        end = len(blocks)
        for idx, other, _ in cands:
            if idx > start and ITEM_ORDER.index(other) > order:
                end = idx
                break
        head_end = start + 1
        if not title and head_end < end and _looks_like_title(blocks[head_end]):
            title = blocks[head_end].text
            head_end += 1
        if chars_between(head_end, end) < MIN_ITEM_CHARS:
            diagnostics["items_short"].append(key)
            continue
        segments.append(ItemSegment(key, title, (start, head_end), (head_end, end)))
    segments.sort(key=lambda s: s.body[0])
    return segments, diagnostics


def _looks_like_title(block: Block) -> bool:
    return block.kind == "text" and len(block.text) <= 120 and (block.bold or block.text.isupper())


def parse_filing(body: bytes) -> ParsedFiling:
    blocks, dei = extract_blocks(body)
    items, diagnostics = segment_items(blocks)
    diagnostics.update(
        blocks=len(blocks),
        tables=sum(1 for b in blocks if b.kind == "table"),
        list_blocks=sum(1 for b in blocks if b.is_list),
    )
    return ParsedFiling(blocks, items, dei, diagnostics)
