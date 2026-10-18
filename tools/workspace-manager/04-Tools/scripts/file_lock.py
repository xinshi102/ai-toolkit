"""Process file locks on Windows and POSIX, released on close or process exit."""
from contextlib import contextmanager
import errno
import os
import time


@contextmanager
def file_lock(path, timeout=30):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as handle:
        if os.name == 'nt':
            import msvcrt
            if os.fstat(handle.fileno()).st_size == 0:
                handle.write(b'\0')
                handle.flush()
            deadline = time.monotonic() + timeout
            while True:
                handle.seek(0)
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError as exc:
                    if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Workspace lock is busy') from exc
                    time.sleep(0.05)
            try:
                yield handle
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            deadline = time.monotonic() + timeout
            while True:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Workspace lock is busy')
                    time.sleep(0.05)
            try:
                yield handle
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)
