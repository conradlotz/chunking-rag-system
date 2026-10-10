"""Command line entry point: ``chunking-lab``."""

from __future__ import annotations

import argparse
import sys

from chunking_lab.rawcache import RawCache


def _fmt_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} GB"


def cache_command(args: argparse.Namespace) -> int:
    cache = RawCache()
    print(f"raw cache: {cache.root}")
    if args.action == "stats":
        st = cache.stats()
        print(f"files: {st.files}  size: {_fmt_bytes(st.bytes)}  originally downloaded: {_fmt_bytes(st.wire_bytes)}"
              f"  companies: {len(st.by_company)}  unreadable entries: {st.corrupt}")
        return 0
    if args.action == "verify":
        problems = cache.verify()
        for line in problems:
            print("PROBLEM", line)
        print("healthy" if not problems else f"{len(problems)} problem(s)")
        return 1 if problems else 0
    if args.action == "clear":
        if not args.yes:
            print("this deletes every cached filing (they can be downloaded again); re-run with --yes to confirm")
            return 2
        print(f"removed {cache.clear()} files")
        return 0
    return 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="chunking-lab")
    sub = parser.add_subparsers(dest="command", required=True)
    cache = sub.add_parser("cache", help="inspect or manage the disposable local raw SEC cache")
    cache.add_argument("action", choices=["stats", "verify", "clear"])
    cache.add_argument("--yes", action="store_true", help="confirm destructive actions")
    cache.set_defaults(func=cache_command)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
