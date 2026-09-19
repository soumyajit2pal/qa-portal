import tempfile

from fastapi import UploadFile

from app.routers.test_execution import _validate_result_evidence


def _upload(name: str, content: bytes, content_type: str) -> UploadFile:
    stream = tempfile.TemporaryFile()
    stream.write(content)
    stream.seek(0)
    return UploadFile(file=stream, filename=name, headers={"content-type": content_type})


def test_execution_evidence_accepts_mp4_video_with_valid_signature():
    upload = _upload("execution.mp4", b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00", "video/mp4")
    try:
        _validate_result_evidence([upload])
    finally:
        upload.file.close()


def test_execution_evidence_accepts_mp4_with_box_before_ftyp():
    content = (
        b"\x00\x00\x00\x10free" + b"\x00" * 8
        + b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00isommp42"
    )
    upload = _upload("execution.mp4", content, "video/mp4")
    try:
        _validate_result_evidence([upload])
    finally:
        upload.file.close()


def test_execution_evidence_keeps_inline_image_validation():
    upload = _upload("screenshot.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 8, "image/png")
    try:
        _validate_result_evidence([upload])
    finally:
        upload.file.close()
