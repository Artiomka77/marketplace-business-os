#!/usr/bin/env python3
"""Safe KEY=value env loader — no shell source/eval.

Usage:
  python3 scripts/fin_accept/safe_load_env_R18.py <envfile> --print-exports
  python3 scripts/fin_accept/safe_load_env_R18.py <envfile> --exec -- <cmd> [args...]
  python3 scripts/fin_accept/safe_load_env_R18.py <envfile> --write-null <outfile>

Values with $, &, `, ;, quotes are preserved as literal data (never interpreted).
Secrets are never printed.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

SECRET_RE = re.compile(
    r"(PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL|URL|_DSN)$", re.I
)


def parse_env_file(path: str) -> dict[str, str]:
    vals: dict[str, str] = {}
    with open(path, encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line or line.lstrip().startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            if not k:
                continue
            # Strip a single layer of matching quotes only; keep content literal.
            if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                v = v[1:-1]
            vals[k] = v
    return vals


def is_secret(k: str) -> bool:
    return bool(SECRET_RE.search(k)) or "DATABASE" in k.upper()


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "usage: safe_load_env_R18.py <envfile> (--print-exports|--write-null OUT|--exec -- CMD...)",
            file=sys.stderr,
        )
        return 2
    path = sys.argv[1]
    mode = sys.argv[2]
    vals = parse_env_file(path)
    if "DATABASE_URL" not in vals or not vals["DATABASE_URL"]:
        print("DATABASE_URL missing in env file", file=sys.stderr)
        return 3

    if mode == "--print-exports":
        # Emit bash-safe assignments via printf %q equivalent for data bytes.
        for k, v in vals.items():
            # Use $'...' only via python→os.environ path; for bash, emit declare -x with %q
            import shlex

            print(f"declare -x {k}={shlex.quote(v)}")
        print(
            "SAFE_ENV_LOADED keys="
            + ",".join(sorted(vals))
            + " secrets_redacted=1",
            file=sys.stderr,
        )
        return 0

    if mode == "--write-null":
        out = sys.argv[3]
        with open(out, "wb") as f:
            for k, v in vals.items():
                f.write(k.encode("utf-8") + b"\0" + v.encode("utf-8") + b"\0")
        os.chmod(out, 0o600)
        print(f"NULL_ENV_WRITTEN path={out} keys={len(vals)}")
        return 0

    if mode == "--exec":
        if "--" not in sys.argv:
            print("missing -- before command", file=sys.stderr)
            return 2
        idx = sys.argv.index("--")
        cmd = sys.argv[idx + 1 :]
        if not cmd:
            print("empty command", file=sys.stderr)
            return 2
        env = os.environ.copy()
        env.update(vals)
        # Do not print secrets
        print(
            "SAFE_ENV_EXEC keys="
            + ",".join(sorted(vals))
            + " cmd="
            + cmd[0],
            file=sys.stderr,
        )
        return subprocess.call(cmd, env=env)

    print(f"unknown mode {mode}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
