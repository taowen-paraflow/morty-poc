"""Drive `claude setup-token` in a pseudo-terminal for the runner.

Protocol on stdio (one JSON object per line), so secrets travel only through pipes, never through logs:
  stdout {"url": "..."}       the Claude sign-in link
  stdin  {"code": "..."}      the code Claude shows after sign-in
  stdout {"token": "..."}     the long-lived token
  stdout {"error": "..."}     on failure
"""

import fcntl
import json
import os
import pty
import re
import select
import struct
import sys
import termios
import time

ANSI = re.compile(rb"\x1b\[[0-9;?>]*[a-zA-Z]|\x1b\][^\x07]*\x07")
URL = re.compile(r"https://claude\.(?:com|ai)/\S*oauth/authorize\S+")
TOKEN = re.compile(r"sk-ant-oat01-[A-Za-z0-9_-]{20,}")


def emit(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()


def read_until(fd, pattern, seconds):
    buffer = b""
    deadline = time.time() + seconds
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 1)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        buffer += chunk
        match = pattern.search(ANSI.sub(b"", buffer).decode(errors="replace"))
        if match:
            return match.group(0)
    return None


def main():
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe("claude", ["claude", "setup-token"], dict(os.environ, BROWSER="false", TERM="dumb", NO_COLOR="1"))
    # A wide terminal keeps the sign-in link on one line.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 4000, 0, 0))
    url = read_until(fd, URL, 90)
    if url is None:
        emit({"error": "claude setup-token did not print a sign-in link"})
        return 1
    emit({"url": url})
    line = sys.stdin.readline()
    try:
        code = json.loads(line)["code"].strip()
    except (ValueError, KeyError, AttributeError):
        emit({"error": "no sign-in code received"})
        return 1
    if not re.fullmatch(r"[A-Za-z0-9_\-#.~]{10,2048}", code):
        emit({"error": "the sign-in code has an unexpected format"})
        return 1
    os.write(fd, code.encode() + b"\r")
    token = read_until(fd, TOKEN, 120)
    if token is None:
        emit({"error": "Claude did not issue a token; the code may be wrong or expired"})
        return 1
    emit({"token": token})
    return 0


if __name__ == "__main__":
    sys.exit(main())
