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

# CSI, OSC, charset designations and other two-byte escapes; Ink styles and positions text with all of them.
ANSI = re.compile(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()*+][0-9A-Za-z]|[=>@-Z\\^_])")
URL = re.compile(r"https://claude\.(?:com|ai)/\S*oauth/authorize\S+")
TOKEN = re.compile(r"sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{20,}")
# Ink renders spaces as cursor moves and may wrap long lines, so the token is read from the screen text with all
# whitespace removed, between the "valid for 1 year" label and the "Store this token" advice that follows it.
TOKEN_BLOCK = re.compile(r"year\)?:(.*?)Storethistoken", re.S)
FAILURE = re.compile(r"(OAuth ?error[^\n]*|[Ii]nvalid ?(?:code|grant)[^\n]*)")
SECRETS = re.compile(r"sk-ant-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{24,}#[A-Za-z0-9_-]{8,}|https://\S+")
transcript = []


def safe_tail():
    """The last screen text with secrets and links removed, for diagnosing a failed sign-in."""
    text = ANSI.sub(b"", b"".join(transcript)).decode(errors="replace")
    text = SECRETS.sub("<redacted>", text)
    lines = [line.strip() for line in text.replace("\r", "\n").split("\n") if line.strip()]
    return " | ".join(lines[-6:])[-400:]


def emit(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()


def find_token(text):
    compact = re.sub(r"\s+", "", text)
    block = TOKEN_BLOCK.search(compact)
    if block is None:
        return None
    match = TOKEN.search(block.group(1))
    return match.group(0) if match else None


def read_until(fd, pattern, seconds, stop=None):
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
        transcript.append(chunk)
        text = ANSI.sub(b"", buffer).decode(errors="replace")
        if pattern is TOKEN:
            token = find_token(text)
            if token is not None:
                return token
        else:
            match = pattern.search(text)
            if match:
                return match.group(0)
        if stop is not None and stop.search(text):
            return None
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
    # Type the code, then press Enter separately, as a terminal paste would.
    os.write(fd, code.encode())
    time.sleep(0.5)
    os.write(fd, b"\r")
    token = read_until(fd, TOKEN, 180, stop=FAILURE)
    if token is None:
        emit({"error": f"Claude did not issue a token. Claude said: {safe_tail() or 'nothing'}"})
        return 1
    emit({"token": token})
    return 0


if __name__ == "__main__":
    sys.exit(main())
