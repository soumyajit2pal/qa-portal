"""Process locks on the shared upload filesystem (POSIX flock required)."""
from contextlib import contextmanager
from pathlib import Path
import fcntl


@contextmanager
def exclusive_file_lock(path):
    """Yield whether the lock was acquired; never mistake failure for ownership.

    The open descriptor holds the lock until release or process exit. The lock
    file must not be unlinked: that would permit two different locked inodes.
    Shared storage must support flock across all API hosts.
    """
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'a+b') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
