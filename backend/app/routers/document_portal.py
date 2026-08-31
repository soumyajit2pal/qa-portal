"""Authenticated, filesystem-backed Document Portal.

This is the QA Portal integration of the supplied Upload Document application.
It deliberately has no delete route: documents remain recoverable and every
write goes through the existing authenticated ``/api`` middleware/audit trail.
Set ``DOCUMENT_PORTAL_ROOT`` to a persistent shared volume in production.
"""
from __future__ import annotations

import mimetypes
import logging
import os
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import unquote

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import models
from ..deps import require_document_portal_contributor, require_document_portal_viewer


router = APIRouter(prefix="/api/document-portal", tags=["Document Portal"])
logger = logging.getLogger("qa_portal.document_portal")

_DEFAULT_ROOT = Path(__file__).resolve().parents[2] / "uploads" / "document_portal"
DOCUMENT_ROOT = Path(os.getenv("DOCUMENT_PORTAL_ROOT", str(_DEFAULT_ROOT))).expanduser().resolve()
DOCUMENT_ROOT.mkdir(parents=True, exist_ok=True)
MAX_FILE_SIZE = int(os.getenv("DOCUMENT_PORTAL_MAX_FILE_SIZE", str(500 * 1024 * 1024)))
MINIMUM_FREE_BYTES = int(os.getenv("DOCUMENT_PORTAL_MINIMUM_FREE_BYTES", str(100 * 1024 * 1024)))
UPLOAD_CHUNK_SIZE = int(os.getenv("DOCUMENT_PORTAL_UPLOAD_CHUNK_SIZE", str(1024 * 1024)))
BLOCKED_EXTENSIONS = frozenset(
    f".{value.strip().lower().lstrip('.')}"
    for value in os.getenv("DOCUMENT_PORTAL_BLOCKED_EXTENSIONS", ".exe,.bat,.cmd,.sh,.ps1,.dll,.com,.msi,.scr").split(",")
    if value.strip()
)
ALLOWED_EXTENSIONS = frozenset(
    f".{value.strip().lower().lstrip('.')}"
    for value in os.getenv("DOCUMENT_PORTAL_ALLOWED_EXTENSIONS", "").split(",")
    if value.strip()
)
WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL", *(f"COM{number}" for number in range(1, 10)), *(f"LPT{number}" for number in range(1, 10)),
}


def _log_user(user: models.User) -> str:
    """Return an audit-safe user identifier without making logging fragile."""
    return str(getattr(user, "username", None) or getattr(user, "id", None) or "unknown")


class FolderCreate(BaseModel):
    path: str = ""
    name: str = Field(min_length=1, max_length=255)


class RenameItem(BaseModel):
    path: str
    name: str = Field(min_length=1, max_length=255)


class MoveItem(BaseModel):
    path: str
    destination: str = ""


class DownloadSelection(BaseModel):
    current_path: str = ""
    paths: list[str] = Field(min_length=1, max_length=200)


def _http_error(message: str, status_code: int = 400) -> HTTPException:
    return HTTPException(status_code=status_code, detail=message)


def _relative(value: str | None = "") -> str:
    decoded = unquote(value or "").replace("\\", "/").strip("/")
    if not decoded:
        return ""
    parts = Path(decoded).parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise _http_error("Invalid document path.")
    return Path(*parts).as_posix()


def _validate_name(value: str, *, is_file: bool = False) -> str:
    name = value.strip()
    if not name or name in {".", ".."}:
        raise _http_error("A name is required.")
    if len(name) > 255 or any(character in name for character in '<>:"/\\|?*') or any(ord(character) < 32 for character in name):
        raise _http_error("The name contains characters that are not allowed.")
    if name.endswith((".", " ")) or Path(name).stem.upper() in WINDOWS_RESERVED:
        raise _http_error("That name is reserved or not supported by the operating system.")
    if is_file:
        suffix = Path(name).suffix.lower()
        if suffix in BLOCKED_EXTENSIONS:
            raise _http_error(f"Files of type {suffix or '(none)'} are blocked.")
        if ALLOWED_EXTENSIONS and suffix not in ALLOWED_EXTENSIONS:
            raise _http_error(f"Files of type {suffix or '(none)'} are not allowed.")
    return name


def _path(value: str | None = "", *, must_exist: bool = False) -> tuple[str, Path]:
    relative = _relative(value)
    # Resolve the configured root for every containment comparison. macOS
    # exposes temporary paths through both /var and /private/var; comparing a
    # resolved child to an unresolved root incorrectly rejects a safe path.
    root = DOCUMENT_ROOT.resolve()
    candidate = root.joinpath(*Path(relative).parts) if relative else root
    current = root
    for part in Path(relative).parts:
        current = current / part
        if current.is_symlink():
            raise _http_error("Symbolic links are not accessible.")
    try:
        candidate.resolve(strict=False).relative_to(root)
    except ValueError as exc:
        raise _http_error("Access outside the document repository is blocked.") from exc
    if must_exist and not candidate.exists():
        raise _http_error("The requested item was not found.", 404)
    return relative, candidate


def _item(path: Path) -> dict:
    resolved = path.resolve(strict=False)
    stat = resolved.stat(follow_symlinks=False)
    relative = resolved.relative_to(DOCUMENT_ROOT.resolve()).as_posix()
    is_folder = resolved.is_dir()
    return {
        "name": resolved.name,
        "path": relative,
        "is_folder": is_folder,
        "size": 0 if is_folder else stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "extension": "Folder" if is_folder else (resolved.suffix[1:].upper() or "FILE"),
    }


def _all_folders() -> list[dict]:
    folders: list[dict] = []
    for root, directory_names, _ in os.walk(DOCUMENT_ROOT.resolve(), followlinks=False):
        root_path = Path(root)
        directory_names[:] = [name for name in directory_names if not (root_path / name).is_symlink()]
        folders.extend(_item(root_path / name) for name in directory_names)
    return sorted(folders, key=lambda item: item["path"].casefold())


def _stats() -> dict:
    folders = files = used = 0
    for root, directory_names, file_names in os.walk(DOCUMENT_ROOT.resolve(), followlinks=False):
        root_path = Path(root)
        directory_names[:] = [name for name in directory_names if not (root_path / name).is_symlink()]
        folders += len(directory_names)
        for name in file_names:
            file_path = root_path / name
            if file_path.is_symlink():
                continue
            files += 1
            try:
                used += file_path.stat().st_size
            except OSError:
                pass
    return {"folders": folders, "files": files, "used": used, "free": shutil.disk_usage(DOCUMENT_ROOT.resolve()).free}


def _next_available(folder: Path, filename: str) -> Path:
    candidate = folder / filename
    if not candidate.exists():
        return candidate
    source = Path(filename)
    number = 1
    while True:
        candidate = folder / f"{source.stem} ({number}){source.suffix}"
        if not candidate.exists():
            return candidate
        number += 1


async def _store_file(folder: Path, upload: UploadFile, filename: str, duplicate: str) -> Path:
    if duplicate not in {"keep", "replace", "cancel"}:
        raise _http_error("Invalid duplicate-file option.")
    destination = folder / filename
    if duplicate == "cancel" and destination.exists():
        raise _http_error(f'"{filename}" already exists.', 409)
    free = shutil.disk_usage(folder).free
    if free <= MINIMUM_FREE_BYTES:
        raise _http_error("Insufficient server storage available.", 507)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{filename}.", suffix=".uploading", dir=folder)
    os.close(handle)
    temporary = Path(temporary_name)
    size = 0
    try:
        with temporary.open("wb") as output:
            while chunk := await upload.read(UPLOAD_CHUNK_SIZE):
                size += len(chunk)
                if size > MAX_FILE_SIZE:
                    raise _http_error(f'"{filename}" exceeds the configured upload-size limit.', 413)
                if free - size < MINIMUM_FREE_BYTES:
                    raise _http_error("Insufficient server storage available.", 507)
                output.write(chunk)
        if duplicate == "replace":
            temporary.replace(destination)
        elif duplicate == "cancel":
            try:
                os.link(temporary, destination)
            except FileExistsError as exc:
                raise _http_error(f'"{filename}" already exists.', 409) from exc
            temporary.unlink()
        else:
            while True:
                try:
                    os.link(temporary, destination)
                    temporary.unlink()
                    break
                except FileExistsError:
                    destination = _next_available(folder, filename)
        return destination
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()


def _archive(items: list[Path], name: str) -> Path:
    handle, archive_name = tempfile.mkstemp(prefix="qap-document-", suffix=".zip")
    os.close(handle)
    archive = Path(archive_name)
    try:
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            for item in items:
                if item.is_file():
                    output.write(item, item.name)
                    continue
                # An explicit directory entry preserves empty folders.
                output.writestr(f"{item.name}/", "")
                for nested in item.rglob("*"):
                    if nested.is_symlink():
                        continue
                    output.write(nested, nested.relative_to(item.parent).as_posix())
        return archive
    except Exception:
        archive.unlink(missing_ok=True)
        raise


# Both forms are accepted explicitly. The UI uses the first form, while a
# bookmarked/manual URL often carries a trailing slash; serving both avoids a
# proxy-dependent redirect during initial repository loading.
@router.get("")
@router.get("/")
def browse(
    path: str = Query(""),
    sort: Literal["name", "type", "size", "modified"] = Query("name"),
    order: Literal["asc", "desc"] = Query("asc"),
    _: models.User = Depends(require_document_portal_viewer),
):
    relative, folder = _path(path, must_exist=True)
    if not folder.is_dir():
        raise _http_error("The requested path is not a folder.")
    items = [_item(item) for item in folder.iterdir() if not item.is_symlink()]
    keys = {
        "name": lambda item: item["name"].casefold(),
        "type": lambda item: (item["extension"], item["name"].casefold()),
        "size": lambda item: (item["size"], item["name"].casefold()),
        "modified": lambda item: item["modified_at"],
    }
    reverse = order == "desc"
    folders = sorted((item for item in items if item["is_folder"]), key=keys[sort], reverse=reverse)
    files = sorted((item for item in items if not item["is_folder"]), key=keys[sort], reverse=reverse)
    breadcrumbs = [{"name": "Document Portal", "path": ""}]
    running: list[str] = []
    for part in Path(relative).parts:
        running.append(part)
        breadcrumbs.append({"name": part, "path": "/".join(running)})
    return {
        "path": relative,
        "items": folders + files,
        "folders": _all_folders(),
        "breadcrumbs": breadcrumbs,
        "stats": _stats() if not relative else None,
        "max_file_size": MAX_FILE_SIZE,
        # This is shown only inside the authenticated Document Portal. It
        # helps authorised operational users verify which configured shared
        # mount they are working in, matching the supplied portal's mounted
        # home indicator without creating a separate anonymous service.
        "repository_path": str(DOCUMENT_ROOT),
    }


@router.get("/search")
def search(q: str = Query("", max_length=200), _: models.User = Depends(require_document_portal_viewer)):
    needle = q.casefold().strip()
    if not needle:
        return {"items": []}
    matches: list[dict] = []
    for root, directory_names, filenames in os.walk(DOCUMENT_ROOT.resolve(), followlinks=False):
        root_path = Path(root)
        directory_names[:] = [name for name in directory_names if not (root_path / name).is_symlink()]
        for name in [*directory_names, *filenames]:
            item = root_path / name
            if item.is_symlink() or needle not in name.casefold():
                continue
            matches.append(_item(item))
            if len(matches) >= 200:
                return {"items": matches, "truncated": True}
    return {"items": matches, "truncated": False}


@router.post("/folders")
def create_folder(payload: FolderCreate, _: models.User = Depends(require_document_portal_contributor)):
    relative, parent = _path(payload.path, must_exist=True)
    if not parent.is_dir():
        raise _http_error("The parent path is not a folder.")
    name = _validate_name(payload.name)
    destination = parent / name
    try:
        destination.mkdir()
    except FileExistsError as exc:
        raise _http_error("An item with that name already exists.", 409) from exc
    item = _item(destination)
    logger.info("Document Portal folder created user=%s path=%s", _log_user(_), item["path"])
    return {"item": item, "parent_path": relative}


@router.post("/upload")
async def upload(
    path: str = Form(""),
    relative_path: str = Form(""),
    duplicate: Literal["keep", "replace", "cancel"] = Form("keep"),
    file: UploadFile = File(...),
    _: models.User = Depends(require_document_portal_contributor),
):
    base, folder = _path(path, must_exist=True)
    if not folder.is_dir():
        raise _http_error("The upload destination is not a folder.")
    relative = _relative(relative_path or file.filename or "")
    parts = list(Path(relative).parts)
    if not parts:
        raise _http_error("The uploaded file path is missing.")
    filename = _validate_name(parts[-1], is_file=True)
    directories = [_validate_name(part) for part in parts[:-1]]
    destination_relative = "/".join([part for part in [base, *directories] if part])
    _, destination_folder = _path(destination_relative)
    destination_folder.mkdir(parents=True, exist_ok=True)
    destination = await _store_file(destination_folder, file, filename, duplicate)
    item = _item(destination)
    logger.info("Document Portal file uploaded user=%s path=%s size=%s duplicate=%s", _log_user(_), item["path"], item["size"], duplicate)
    return {"item": item, "saved_as": destination.name}


@router.post("/items/rename")
def rename(payload: RenameItem, _: models.User = Depends(require_document_portal_contributor)):
    _, source = _path(payload.path, must_exist=True)
    if source == DOCUMENT_ROOT.resolve():
        raise _http_error("The document repository root cannot be renamed.")
    destination = source.with_name(_validate_name(payload.name, is_file=source.is_file()))
    if destination.exists():
        raise _http_error("An item with that name already exists.", 409)
    source.rename(destination)
    item = _item(destination)
    logger.info("Document Portal item renamed user=%s source=%s destination=%s", _log_user(_), payload.path, item["path"])
    return {"item": item}


@router.post("/items/move")
def move(payload: MoveItem, _: models.User = Depends(require_document_portal_contributor)):
    _, source = _path(payload.path, must_exist=True)
    _, destination_folder = _path(payload.destination, must_exist=True)
    if source == DOCUMENT_ROOT.resolve():
        raise _http_error("The document repository root cannot be moved.")
    if not destination_folder.is_dir():
        raise _http_error("The destination is not a folder.")
    if source.is_dir():
        try:
            destination_folder.resolve().relative_to(source.resolve())
            raise _http_error("A folder cannot be moved inside itself or its descendants.")
        except ValueError:
            pass
    target = destination_folder / source.name
    if target.exists():
        raise _http_error("An item with that name already exists in the destination.", 409)
    shutil.move(str(source), str(target))
    item = _item(target)
    logger.info("Document Portal item moved user=%s source=%s destination=%s", _log_user(_), payload.path, item["path"])
    return {"item": item}


@router.get("/download")
def download(path: str = Query(...), _: models.User = Depends(require_document_portal_viewer)):
    _, document = _path(path, must_exist=True)
    if not document.is_file():
        raise _http_error("Select a file to download.")
    logger.info("Document Portal file download requested user=%s path=%s size=%s", _log_user(_), path, document.stat().st_size)
    return FileResponse(document, media_type=mimetypes.guess_type(document.name)[0] or "application/octet-stream", filename=document.name)


@router.get("/zip")
def download_folder_zip(background_tasks: BackgroundTasks, path: str = Query(""), _: models.User = Depends(require_document_portal_viewer)):
    _, folder = _path(path, must_exist=True)
    if not folder.is_dir():
        raise _http_error("Select a folder to download as ZIP.")
    archive = _archive([folder], folder.name or "document-portal")
    background_tasks.add_task(archive.unlink, missing_ok=True)
    logger.info("Document Portal folder ZIP download requested user=%s path=%s", _log_user(_), path or "<root>")
    return FileResponse(archive, media_type="application/zip", filename=f"{folder.name or 'document-portal'}.zip")


@router.post("/download-selection")
def download_selection(payload: DownloadSelection, background_tasks: BackgroundTasks, _: models.User = Depends(require_document_portal_viewer)):
    _, current = _path(payload.current_path, must_exist=True)
    if not current.is_dir():
        raise _http_error("The current location is not a folder.")
    selected: list[Path] = []
    seen: set[Path] = set()
    for value in payload.paths:
        _, item = _path(value, must_exist=True)
        if item.is_symlink() or item.parent.resolve() != current.resolve():
            raise _http_error("Selected items must belong to the current folder.")
        resolved = item.resolve()
        if resolved not in seen:
            seen.add(resolved)
            selected.append(item)
    if len(selected) == 1 and selected[0].is_file():
        item = selected[0]
        logger.info(
            "Document Portal selection download requested user=%s type=file count=1 path=%s",
            _log_user(_),
            item.relative_to(DOCUMENT_ROOT.resolve()).as_posix(),
        )
        return FileResponse(item, media_type=mimetypes.guess_type(item.name)[0] or "application/octet-stream", filename=item.name)
    archive = _archive(selected, f"{current.name or 'document-portal'}-selection")
    background_tasks.add_task(archive.unlink, missing_ok=True)
    logger.info(
        "Document Portal selection ZIP download requested user=%s count=%s paths=%s",
        _log_user(_),
        len(selected),
        ",".join(item.relative_to(DOCUMENT_ROOT.resolve()).as_posix() for item in selected),
    )
    return FileResponse(archive, media_type="application/zip", filename=f"{current.name or 'document-portal'}-selection.zip")
