"""Per-file limits for the QA Request Attach Evidence section."""
import os
from typing import Iterable

from fastapi import HTTPException, UploadFile

QA_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024
DOCUMENT_BATCH_MAX_FILES = 20
GENERAL_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024
BLOCKED_DOCUMENT_EXTENSIONS = {
    ".asp", ".aspx", ".bat", ".cmd", ".com", ".dll", ".exe", ".hta",
    ".htm", ".html", ".jar", ".js", ".jsp", ".mjs", ".msi", ".php",
    ".ps1", ".scr", ".sh", ".svg", ".vbs", ".wasm",
}
ALLOWED_DOCUMENT_EXTENSIONS = {
    ".csv", ".doc", ".docx", ".eml", ".gif", ".har", ".jpeg", ".jpg",
    ".jmx", ".json", ".log", ".msg", ".pdf", ".png", ".ppt", ".pptx",
    ".txt", ".webp", ".xls", ".xlsx", ".xml", ".zip",
    ".avi", ".mov", ".mp4", ".webm",
}
_ZIP_EXTENSIONS = {".docx", ".pptx", ".xlsx", ".zip"}
_OLE_EXTENSIONS = {".doc", ".msg", ".ppt", ".xls"}
_TEXT_EXTENSIONS = {".csv", ".eml", ".har", ".jmx", ".json", ".log", ".txt", ".xml"}
_MEDIA_SIGNATURE_PROBE_BYTES = 64 * 1024


def _has_iso_base_media_ftyp(header: bytes) -> bool:
    """Return whether an ISO Base Media file has a structurally valid ftyp box.

    ``ftyp`` is normally the first box in an MP4/MOV file, but valid encoders may
    put boxes such as ``free``, ``skip`` or ``wide`` before it.  Walk the box
    boundaries instead of requiring ``ftyp`` at one fixed byte offset (or doing
    an unsafe raw substring search).
    """
    offset = 0
    while offset + 8 <= len(header):
        box_size = int.from_bytes(header[offset:offset + 4], "big")
        box_type = header[offset + 4:offset + 8]
        box_header_size = 8

        if box_size == 1:
            if offset + 16 > len(header):
                return False
            box_size = int.from_bytes(header[offset + 8:offset + 16], "big")
            box_header_size = 16
        elif box_size == 0:
            box_size = len(header) - offset

        if box_size < box_header_size:
            return False
        if box_type == b"ftyp":
            # The payload starts with a four-byte major brand and a four-byte
            # minor version. The whole declared box need not fit in the bounded
            # probe when a file has a long compatible-brand list.
            return box_size >= box_header_size + 8 and offset + box_header_size + 8 <= len(header)

        next_offset = offset + box_size
        if next_offset <= offset or next_offset > len(header):
            return False
        offset = next_offset
    return False


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


def validate_document_file_types(files: Iterable[UploadFile]) -> list[UploadFile]:
    """Reject executable/web content and malformed names before storage."""
    uploads = list(files)
    if not uploads:
        raise HTTPException(status_code=400, detail="Select at least one file")
    if len(uploads) > DOCUMENT_BATCH_MAX_FILES:
        raise HTTPException(
            status_code=400,
            detail=f"Upload at most {DOCUMENT_BATCH_MAX_FILES} files at a time",
        )
    for upload in uploads:
        filename = os.path.basename(upload.filename or "")
        if not filename or filename in {".", ".."}:
            raise HTTPException(status_code=400, detail="Every upload must have a valid file name")
        extension = os.path.splitext(filename)[1].lower()
        if extension in BLOCKED_DOCUMENT_EXTENSIONS or extension not in ALLOWED_DOCUMENT_EXTENSIONS:
            raise HTTPException(
                status_code=415,
                detail=f'"{filename}" is not an allowed document type',
            )
        position = upload.file.tell()
        try:
            upload.file.seek(0)
            header = upload.file.read(_MEDIA_SIGNATURE_PROBE_BYTES)
        finally:
            upload.file.seek(position)
        valid_signature = True
        if extension == ".pdf":
            valid_signature = header.startswith(b"%PDF-")
        elif extension == ".png":
            valid_signature = header.startswith(b"\x89PNG\r\n\x1a\n")
        elif extension in {".jpg", ".jpeg"}:
            valid_signature = header.startswith(b"\xff\xd8\xff")
        elif extension == ".gif":
            valid_signature = header.startswith((b"GIF87a", b"GIF89a"))
        elif extension == ".webp":
            valid_signature = header.startswith(b"RIFF") and header[8:12] == b"WEBP"
        elif extension in _ZIP_EXTENSIONS:
            valid_signature = header.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"))
        elif extension in _OLE_EXTENSIONS:
            valid_signature = header.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
        elif extension in _TEXT_EXTENSIONS:
            valid_signature = b"\x00" not in header
        elif extension in {".mp4", ".mov"}:
            valid_signature = _has_iso_base_media_ftyp(header)
        elif extension == ".webm":
            valid_signature = header.startswith(b"\x1a\x45\xdf\xa3")
        elif extension == ".avi":
            valid_signature = header.startswith(b"RIFF") and header[8:12] == b"AVI "
        if not valid_signature:
            raise HTTPException(
                status_code=415,
                detail=f'"{filename}" content does not match its file extension',
            )
    return uploads


def validate_document_uploads(files: Iterable[UploadFile]) -> None:
    """Apply the common evidence-upload boundary before writing any file."""
    uploads = validate_document_file_types(files)
    for upload in uploads:
        filename = os.path.basename(upload.filename or "")
        position = upload.file.tell()
        try:
            upload.file.seek(0, os.SEEK_END)
            size = upload.file.tell()
        finally:
            upload.file.seek(position)
        if size > GENERAL_DOCUMENT_MAX_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f'"{filename}" exceeds the 25 MB evidence-file limit',
            )
