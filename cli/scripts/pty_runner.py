#!/usr/bin/env python3
"""Small release-test PTY bridge; never shipped in the npm package.

The parent process may use pipes, but the child is forked under a real Unix
PTY. Bytes are forwarded without interpreting customer text. The child exit
status is returned after the master is drained, so a marker before a crash
cannot be mistaken for success.
"""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def set_size(fd, columns=100, rows=32):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def main():
    if len(sys.argv) < 2:
        return 64
    child, master = pty.fork()
    if child == 0:
        os.execvp(sys.argv[1], sys.argv[1:])
    set_size(master)
    stopped = False
    deadline = time.monotonic() + 40

    def signal_child(signum):
        try:
            os.killpg(os.getpgid(child), signum)
        except OSError:
            try:
                os.kill(child, signum)
            except OSError:
                pass

    def stop(_signum, _frame):
        nonlocal stopped, deadline
        stopped = True
        signal_child(signal.SIGTERM)
        deadline = min(deadline, time.monotonic() + 2)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    os.set_blocking(master, False)
    os.set_blocking(sys.stdin.fileno(), False)
    eof = False
    status = None
    while time.monotonic() < deadline:
        if status is None:
            waited, result = os.waitpid(child, os.WNOHANG)
            if waited == child:
                status = result
        readable = [master]
        if not eof:
            readable.append(sys.stdin.fileno())
        try:
            ready, _, _ = select.select(readable, [], [], 0.05)
        except (OSError, ValueError):
            ready = []
        for fd in ready:
            if fd == master:
                try:
                    data = os.read(master, 65536)
                    if data:
                        os.write(sys.stdout.fileno(), data)
                except OSError as error:
                    if error.errno not in (errno.EIO, errno.EBADF):
                        raise
            else:
                try:
                    data = os.read(sys.stdin.fileno(), 65536)
                except OSError:
                    data = b''
                if data:
                    os.write(master, data)
                else:
                    eof = True
                    # A closed bridge input represents terminal EOF. In raw
                    # mode the child receives the conventional EOT byte;
                    # keeping the master open lets it restore the terminal
                    # and report its real exit status before we reap it.
                    try:
                        os.write(master, b'\x04')
                    except OSError:
                        pass
                    # Do not close the PTY master just because the bridge's
                    # stdin reached EOF.  The child may be a long-lived
                    # terminal application whose stdin is intentionally kept
                    # open by its parent.  Closing the master here sends a
                    # hangup and can turn a healthy child into an apparent
                    # 129/SIGHUP failure before its output is drained.
        if status is not None:
            # Drain output for a short bounded interval after child exit.
            try:
                data = os.read(master, 65536)
                if data:
                    os.write(sys.stdout.fileno(), data)
                    continue
            except OSError:
                pass
            break
    else:
        stop(signal.SIGTERM, None)
    if status is None and stopped:
        grace_deadline = time.monotonic() + 2
        while time.monotonic() < grace_deadline and status is None:
            waited, result = os.waitpid(child, os.WNOHANG)
            if waited == child:
                status = result
                break
            time.sleep(0.05)
        if status is None:
            signal_child(signal.SIGKILL)
            _, status = os.waitpid(child, 0)
    if status is None:
        _, status = os.waitpid(child, 0)
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


if __name__ == '__main__':
    sys.exit(main())
