"""POSIX process-safe rotation for workers sharing one application log."""
import fcntl
import logging.handlers


class ProcessSafeRotatingFileHandler(logging.handlers.RotatingFileHandler):
    """Hold a shared lock across reopening, rotation and the complete write.

    Each worker must reopen the active file: another process may have rotated
    its previous descriptor. The stable lock file must never be deleted during
    operation. As with upload locks, shared storage must implement flock.
    """

    def emit(self, record):
        try:
            with open(self.baseFilename + '.lock', 'a+b') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                try:
                    if self.stream is not None:
                        self.stream.close()
                        self.stream = None
                    super().emit(record)
                finally:
                    fcntl.flock(lock, fcntl.LOCK_UN)
        except Exception:
            self.handleError(record)
