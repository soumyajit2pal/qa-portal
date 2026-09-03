"""Per-file limits for the QA Request Attach Evidence section."""
import os
from typing import Iterable

from fastapi import HTTPException, UploadFile

QA_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024


def validate_qa_document_sizes(files: Iterable[UploadFile]) -> None:
    """Validate the whole batch before any files or document records are saved.

    Inspect the actual spooled file rather than trusting client metadata.
    Seeking avoids reading large uploads into memory and preserves the cursor.
    """
    for upload in files:
        position = upload.file.tell()
        try:
            upload.file.seek(0, os.SEEK_END)
            size = upload.file.tell()
        finally:
            upload.file.seek(position)
        if size > QA_DOCUMENT_MAX_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f'"{upload.filename or "Unnamed file"}" exceeds the 10 MB limit. Each file must be 10 MB or smaller.',
            )
