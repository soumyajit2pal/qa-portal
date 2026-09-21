"""Suite-wide test isolation.

Application modules configure file logging at import time. Keep test traffic,
mocked failures, and fixture identities out of the runtime log directory so a
developer can trust ``backend/logs/app.log`` while diagnosing the service.
"""
import os
import tempfile
from pathlib import Path


os.environ.setdefault(
    "LOG_DIR",
    str(Path(tempfile.gettempdir()) / "qualityops-test-logs"),
)
