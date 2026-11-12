"""Drive `claude setup-token` in a pseudo-terminal for the runner.

Claude Code draws a full-screen terminal UI: it positions text with cursor moves, styles it, and redraws lines, so
its raw output cannot be read with a regular expression. The output is fed into a terminal emulator (pyte) and the
link and token are read from the rendered screen, the way a person would see them.

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

import pyte

COLUMNS, ROWS = 1000, 80
URL = re.compile(r"https://claude\.(?:com|ai)/\S*oauth/authorize\S+")
TOKEN = re.compile(r"sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{20,}")
FAILURE = re.compile(r"OAuth error.*|[Ii]nvalid (?:code|grant).*")
SECRETS = re.compile(r"sk-ant-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{24,}#[A-Za-z0-9_-]{8,}|https://\S+")


def emit(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()


class Terminal:
    def __init__(self, fd):
        self.fd = fd
        self.screen = pyte.Screen(COLUMNS, ROWS)
        self.stream = pyte.ByteStream(self.screen)

    def lines(self):
        return [line.rstrip() for line in self.screen.display if line.strip()]

    def text(self):
        return "\n".join(self.lines())

    def wait(self, find, seconds):
        """Feeds output into the screen until `find(screen text)` returns a value or the time runs out."""
        deadline = time.time() + seconds
        while time.time() < deadline:
            ready, _, _ = select.select([self.fd], [], [], 0.5)
            if ready:
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                self.stream.feed(chunk)
            result = find(self.text())
            if result is not None:
                return result
        return find(self.text())

    def safe_tail(self):
        """The last lines on screen with secrets and links removed, for diagnosing a failed sign-in."""
        lines = [SECRETS.sub("<redacted>", line.strip()) for line in self.lines()]
        return " | ".join(lines[-5:])[-400:]


def find_url(text):
    match = URL.search(text)
    return match.group(0) if match else None


def find_token(text):
    """The token sits between the "valid for 1 year" label and the "Store this token" advice; a narrow terminal
    could wrap it, so the lines between them are joined before matching."""
    lines = text.split("\n")
    start = next((index for index, line in enumerate(lines) if "valid for 1 year" in line), None)
    if start is None:
        return None
    end = next((index for index in range(start + 1, len(lines)) if "Store this token" in lines[index]), None)
    if end is None:
        return None
    match = TOKEN.search("".join(line.strip() for line in lines[start + 1 : end]))
    return match.group(0) if match else None


def find_token_or_failure(text):
    token = find_token(text)
    if token is not None:
        return ("token", token)
    failure = FAILURE.search(text)
    return ("failure", failure.group(0)) if failure else None


def main():
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe("claude", ["claude", "setup-token"], dict(os.environ, BROWSER="false", TERM="xterm-256color"))
    # A wide terminal keeps the sign-in link and the token on one line each.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLUMNS, 0, 0))
    terminal = Terminal(fd)
    url = terminal.wait(find_url, 90)
    if url is None:
        emit({"error": f"claude setup-token did not show a sign-in link. Claude said: {terminal.safe_tail() or 'nothing'}"})
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
    result = terminal.wait(find_token_or_failure, 180)
    if result is None or result[0] != "token":
        emit({"error": f"Claude did not issue a token. Claude said: {terminal.safe_tail() or 'nothing'}"})
        return 1
    emit({"token": result[1]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
