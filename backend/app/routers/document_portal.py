"""Authenticated, filesystem-backed Document Portal.

This is the QA Portal integration of the supplied Upload Document application.
Deletion is restricted to the Document Portal Manager role; every write goes
through the existing authenticated ``/api`` middleware/audit trail.
Set ``DOCUMENT_PORTAL_STORAGE_HOST_PATH`` to a persistent shared volume in
production.
"""
from __future__ import annotations

import mimetypes
import logging
import os
import shutil
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import unquote

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..config import settings
from ..database import get_db
from ..document_portal_storage import OWNER_FILE, prepare_existing_roots, workspace_root
from ..storage_lock import exclusive_file_lock
from ..deps import (
    require_document_portal_contributor,
    require_document_portal_manager,
    require_document_portal_viewer,
)


router = APIRouter(prefix="/api/document-portal", tags=["Document Portal"])
logger = logging.getLogger("qa_portal.document_portal")

_DEFAULT_ROOT = Path(__file__).resolve().parents[2] / "uploads" / "document_portal"
DOCUMENT_ROOT = Path(settings.document_portal_storage_host_path or _DEFAULT_ROOT).expanduser().resolve()
DOCUMENT_ROOT.mkdir(parents=True, exist_ok=True)
MINIMUM_FREE_BYTES = settings.document_portal_minimum_free_bytes
UPLOAD_CHUNK_SIZE = settings.document_portal_upload_chunk_size
BLOCKED_EXTENSIONS = frozenset(
    f".{value.strip().lower().lstrip('.')}"
    for value in settings.document_portal_blocked_extensions.split(",")
    if value.strip()
)
ALLOWED_EXTENSIONS = frozenset(
    f".{value.strip().lower().lstrip('.')}"
    for value in settings.document_portal_allowed_extensions.split(",")
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


class UploadCapacityCheck(BaseModel):
    total_size: int = Field(ge=0)
    file_count: int = Field(ge=1)


def _http_error(message: str, status_code: int = 400) -> HTTPException:
    return HTTPException(status_code=status_code, detail=message)


def _scope(db: Session, user: models.User) -> tuple[Path, models.QAWorkspace]:
    try:
        prepare_existing_roots(db, repository_root=DOCUMENT_ROOT)
    except (RuntimeError, FileExistsError, ValueError) as exc:
        raise _http_error(str(exc), 503) from exc
    workspace_id = getattr(user, 'active_qa_workspace_id', None)
    workspace = db.get(models.QAWorkspace, workspace_id) if workspace_id else None
    if not workspace or not workspace.is_active:
        raise _http_error('Select an active workspace before using Document Management.', 403)
    try:
        root = workspace_root(workspace, repository_root=DOCUMENT_ROOT, create=True)
    except (FileExistsError, ValueError) as exc:
        raise _http_error(str(exc), 409) from exc
    return root, workspace


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
    if name.startswith('.qualityops-') or name.endswith('.uploading'):
        raise _http_error('This name is reserved for Document Portal storage.')
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


def _path(value: str | None = "", *, must_exist: bool = False, root: Path | None = None) -> tuple[str, Path]:
    relative = _relative(value)
    # Resolve the configured root for every containment comparison. macOS
    # exposes temporary paths through both /var and /private/var; comparing a
    # resolved child to an unresolved root incorrectly rejects a safe path.
    root = (root or DOCUMENT_ROOT).resolve()
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


def _item(path: Path, root: Path | None = None) -> dict:
    resolved = path.resolve(strict=False)
    stat = resolved.stat(follow_symlinks=False)
    relative = resolved.relative_to((root or DOCUMENT_ROOT).resolve()).as_posix()
    is_folder = resolved.is_dir()
    return {
        "name": resolved.name,
        "path": relative,
        "is_folder": is_folder,
        "size": 0 if is_folder else stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "extension": "Folder" if is_folder else (resolved.suffix[1:].upper() or "FILE"),
    }


def _all_folders(root: Path | None = None) -> list[dict]:
    folders: list[dict] = []
    for directory, directory_names, _ in os.walk((root or DOCUMENT_ROOT).resolve(), followlinks=False):
        root_path = Path(directory)
        directory_names[:] = [name for name in directory_names if not (root_path / name).is_symlink()]
        folders.extend(_item(root_path / name, root) for name in directory_names)
    return sorted(folders, key=lambda item: item["path"].casefold())


def _stats(root: Path | None = None) -> dict:
    folders = files = used = 0
    scope_root = (root or DOCUMENT_ROOT).resolve()
    for directory, directory_names, file_names in os.walk(scope_root, followlinks=False):
        root_path = Path(directory)
        directory_names[:] = [name for name in directory_names if not (root_path / name).is_symlink()]
        folders += len(directory_names)
        for name in file_names:
            if (root_path == scope_root and name == OWNER_FILE) or (name.startswith('.') and name.endswith('.uploading')):
                continue
            file_path = root_path / name
            if file_path.is_symlink():
                continue
            files += 1
            try:
                used += file_path.stat().st_size
            except OSError:
                pass
    return {"folders": folders, "files": files, "used": used, "free": shutil.disk_usage(scope_root).free}


def _quota_family(db: Session, workspace: models.QAWorkspace) -> tuple[int, int | None, list[Path]]:
    """Return the shared quota owner and every root charged to that owner."""
    parent = db.get(models.QAWorkspace, workspace.parent_workspace_id) if workspace.parent_workspace_id else workspace
    if parent is None:
        raise _http_error('The parent workspace was not found.', 409)
    members = [parent, *db.query(models.QAWorkspace).filter(
        models.QAWorkspace.parent_workspace_id == parent.id).all()]
    try:
        roots = [workspace_root(member, repository_root=DOCUMENT_ROOT, create=True) for member in members]
    except (FileExistsError, ValueError) as exc:
        raise _http_error(str(exc), 409) from exc
    return parent.id, parent.document_portal_quota_bytes, roots


def _family_used(roots: list[Path]) -> int:
    return sum(_stats(root)['used'] for root in roots)


def _upload_capacity(folder: Path | None = None, *, root: Path | None = None, quota_bytes: int | None = None,
                     family_roots: list[Path] | None = None, family_quota_bytes: int | None = None) -> dict:
    """Storage that a new upload may consume while preserving the reserve."""
    free = shutil.disk_usage((folder or DOCUMENT_ROOT).resolve()).free
    used = _stats(root)['used'] if root and quota_bytes is not None else 0
    quota_available = max(0, quota_bytes - used) if quota_bytes is not None else (0 if root else max(0, free - MINIMUM_FREE_BYTES))
    family_used = _family_used(family_roots) if family_roots is not None else used
    family_available = max(0, family_quota_bytes - family_used) if family_quota_bytes is not None else (0 if family_roots is not None else quota_available)
    return {
        "free_bytes": free,
        "reserved_bytes": MINIMUM_FREE_BYTES,
        "quota_bytes": quota_bytes,
        "used_bytes": used,
        "family_quota_bytes": family_quota_bytes,
        "family_used_bytes": family_used,
        "available_bytes": min(max(0, free - MINIMUM_FREE_BYTES), quota_available, family_available),
    }


def _format_bytes(value: int) -> str:
    size = float(max(0, value))
    units = ("B", "KB", "MB", "GB", "TB")
    unit = units[0]
    for unit in units:
        if size < 1024 or unit == units[-1]:
            break
        size /= 1024
    return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"


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


async def _store_file(folder: Path, upload: UploadFile, filename: str, duplicate: str,
                      *, root: Path | None = None, quota_bytes: int | None = None,
                      workspace_id: int | None = None, family_id: int | None = None,
                      family_roots: list[Path] | None = None, family_quota_bytes: int | None = None,
                      db: Session | None = None) -> Path:
    if duplicate not in {"keep", "replace", "cancel"}:
        raise _http_error("Invalid duplicate-file option.")
    destination = folder / filename
    if duplicate == "cancel" and destination.exists():
        raise _http_error(f'"{filename}" already exists.', 409)
    if root and quota_bytes is None:
        raise _http_error('Ask an administrator to set this workspace’s Document Portal storage limit before uploading.', 409)
    if family_roots is not None and family_quota_bytes is None:
        raise _http_error('Ask an administrator to set the parent workspace’s Document Portal storage limit before uploading.', 409)
    lock_path = DOCUMENT_ROOT / f'.workspace-{family_id or workspace_id}.quota.lock' if (family_id or workspace_id) else DOCUMENT_ROOT / '.repository.quota.lock'
    with exclusive_file_lock(lock_path) as acquired:
        if not acquired:
            raise _http_error('Another upload is using this workspace storage. Try again shortly.', 409)
        if db is not None and workspace_id is not None and family_id is not None:
            current_workspace = db.get(models.QAWorkspace, workspace_id)
            current_family = db.get(models.QAWorkspace, family_id)
            if current_workspace is None or current_family is None:
                raise _http_error('The workspace storage settings changed. Try again.', 409)
            db.refresh(current_workspace)
            if current_family.id != current_workspace.id:
                db.refresh(current_family)
            quota_bytes = current_workspace.document_portal_quota_bytes
            family_quota_bytes = current_family.document_portal_quota_bytes
            if quota_bytes is None or family_quota_bytes is None:
                raise _http_error('Ask an administrator to set both workspace and parent storage limits before uploading.', 409)
        free = shutil.disk_usage(folder).free
        if free <= MINIMUM_FREE_BYTES:
            raise _http_error("Insufficient server storage available.", 507)
        used = _stats(root)['used'] if root and quota_bytes is not None else 0
        family_used = _family_used(family_roots) if family_roots is not None else used
        replace_credit = destination.stat().st_size if duplicate == 'replace' and destination.is_file() else 0
        handle, temporary_name = tempfile.mkstemp(prefix=f".{filename}.", suffix=".uploading", dir=folder)
        os.close(handle)
        temporary = Path(temporary_name)
        size = 0
        try:
            with temporary.open("wb") as output:
                while chunk := await upload.read(UPLOAD_CHUNK_SIZE):
                    size += len(chunk)
                    if free - size < MINIMUM_FREE_BYTES:
                        raise _http_error("Insufficient server storage available.", 507)
                    if quota_bytes is not None and used + size - replace_credit > quota_bytes:
                        raise _http_error(
                            f'Workspace storage limit exceeded. {_format_bytes(max(0, quota_bytes - used + replace_credit))} remains for this upload.', 507)
                    if family_quota_bytes is not None and family_used + size - replace_credit > family_quota_bytes:
                        raise _http_error('Parent workspace storage limit exceeded. Free space in this workspace family before uploading.', 507)
                    output.write(chunk)
            if quota_bytes is not None:
                current_used = _stats(root)['used']
                current_credit = destination.stat().st_size if duplicate == 'replace' and destination.is_file() else 0
                if current_used + size - current_credit > quota_bytes:
                    raise _http_error('Workspace storage limit changed during upload. Retry after checking available space.', 507)
            if family_quota_bytes is not None and family_roots is not None:
                if _family_used(family_roots) + size - current_credit > family_quota_bytes:
                    raise _http_error('Parent workspace storage limit changed during upload. Retry after checking available space.', 507)
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
                    if nested.is_symlink() or nested.name == OWNER_FILE:
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
    db: Session = Depends(get_db),
):
    root, workspace = _scope(db, _)
    relative, folder = _path(path, must_exist=True, root=root)
    if not folder.is_dir():
        raise _http_error("The requested path is not a folder.")
    items = [_item(item, root) for item in folder.iterdir() if not item.is_symlink() and item.name != OWNER_FILE]
    keys = {
        "name": lambda item: item["name"].casefold(),
        "type": lambda item: (item["extension"], item["name"].casefold()),
        "size": lambda item: (item["size"], item["name"].casefold()),
        "modified": lambda item: item["modified_at"],
    }
    reverse = order == "desc"
    folders = sorted((item for item in items if item["is_folder"]), key=keys[sort], reverse=reverse)
    files = sorted((item for item in items if not item["is_folder"]), key=keys[sort], reverse=reverse)
    breadcrumbs = [{"name": workspace.name, "path": ""}]
    running: list[str] = []
    for part in Path(relative).parts:
        running.append(part)
        breadcrumbs.append({"name": part, "path": "/".join(running)})
    _, family_quota, family_roots = _quota_family(db, workspace)
    capacity = _upload_capacity(folder, root=root, quota_bytes=workspace.document_portal_quota_bytes,
                                family_roots=family_roots, family_quota_bytes=family_quota)
    return {
        "path": relative,
        "items": folders + files,
        "folders": _all_folders(root),
        "breadcrumbs": breadcrumbs,
        "stats": {**_stats(root), "free": capacity['available_bytes']} if not relative else None,
        "upload_capacity": capacity["available_bytes"],
        "workspace_name": workspace.name,
        "storage_limit_bytes": workspace.document_portal_quota_bytes,
        "family_storage_limit_bytes": family_quota,
        "family_storage_used_bytes": capacity['family_used_bytes'],
        "parent_storage_limit_bytes": family_quota if workspace.parent_workspace_id else None,
        "parent_storage_used_bytes": capacity['family_used_bytes'] if workspace.parent_workspace_id else None,
        # This is shown only inside the authenticated Document Portal. It
        # helps authorised operational users verify which configured shared
        # mount they are working in, matching the supplied portal's mounted
        # home indicator without creating a separate anonymous service.
        "repository_path": str(root),
    }


@router.post("/upload/validate")
def validate_upload_capacity(
    payload: UploadCapacityCheck,
    path: str = Query(""),
    _: models.User = Depends(require_document_portal_contributor),
    db: Session = Depends(get_db),
):
    """Reject an entire upload queue before the first file is transferred."""
    root, workspace = _scope(db, _)
    _, folder = _path(path, must_exist=True, root=root)
    if not folder.is_dir():
        raise _http_error("The upload destination is not a folder.")
    if workspace.document_portal_quota_bytes is None:
        raise _http_error('Ask an administrator to set this workspace’s Document Portal storage limit before uploading.', 409)
    _, family_quota, family_roots = _quota_family(db, workspace)
    if family_quota is None:
        raise _http_error('Ask an administrator to set the parent workspace’s Document Portal storage limit before uploading.', 409)
    capacity = _upload_capacity(folder, root=root, quota_bytes=workspace.document_portal_quota_bytes,
                                family_roots=family_roots, family_quota_bytes=family_quota)
    if payload.total_size > capacity["available_bytes"]:
        raise _http_error(
            f"The selected {payload.file_count} file(s) require {_format_bytes(payload.total_size)}, "
            f"but only {_format_bytes(capacity['available_bytes'])} is available for uploads. "
            "Remove files from the queue or free repository storage, then try again.",
            507,
        )
    return {
        "allowed": True,
        "requested_bytes": payload.total_size,
        **capacity,
    }


@router.get("/search")
def search(q: str = Query("", max_length=200), _: models.User = Depends(require_document_portal_viewer),
           db: Session = Depends(get_db)):
    scope_root, _workspace = _scope(db, _)
    needle = q.casefold().strip()
    if not needle:
        return {"items": []}
    matches: list[dict] = []
    for directory, directory_names, filenames in os.walk(scope_root, followlinks=False):
        root_path = Path(directory)
        directory_names[:] = [name for name in directory_names if not (root_path / name).is_symlink()]
        for name in [*directory_names, *filenames]:
            if name == OWNER_FILE:
                continue
            item = root_path / name
            if item.is_symlink() or needle not in name.casefold():
                continue
            matches.append(_item(item, scope_root))
            if len(matches) >= 200:
                return {"items": matches, "truncated": True}
    return {"items": matches, "truncated": False}


def _inventory_rows(root: Path, workspace_name: str,
                    date_from: str | None = None, date_to: str | None = None) -> list[dict]:
    """Metadata only, from the selected workspace's mounted repository."""
    ist = timezone(timedelta(hours=5, minutes=30))

    def bound(value: str | None):
        if not value:
            return None
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=ist)

    start, end = bound(date_from), bound(date_to)
    rows = []
    for directory, folder_names, file_names in os.walk(root, followlinks=False):
        folder_names[:] = [name for name in folder_names if not (Path(directory) / name).is_symlink()]
        for name in file_names:
            if name == OWNER_FILE or name.endswith('.uploading'):
                continue
            file_path = Path(directory) / name
            if file_path.is_symlink():
                continue
            info = _item(file_path, root)
            modified = datetime.fromisoformat(info['modified_at'])
            if (start and modified < start) or (end and modified > end):
                continue
            rows.append({
                'Workspace': workspace_name,
                'Document': info['name'],
                'Folder': str(Path(info['path']).parent) if Path(info['path']).parent != Path('.') else 'Workspace root',
                'Relative Path': info['path'],
                'Type': info['extension'],
                'Size (bytes)': info['size'],
                'Last Modified (IST)': modified.astimezone(ist).isoformat(),
            })
    return sorted(rows, key=lambda row: row['Relative Path'].casefold())


@router.get('/inventory/export')
def export_inventory(format: Literal['xlsx', 'pdf', 'csv'] = Query('xlsx'),
                     date_from: str | None = None, date_to: str | None = None,
                     _: models.User = Depends(require_document_portal_viewer),
                     db: Session = Depends(get_db)):
    """Governed workspace file inventory, generated by the storage service."""
    from .export import _rows_to_csv, _rows_to_pdf, _rows_to_xlsx
    root, workspace = _scope(db, _)
    rows = _inventory_rows(root, workspace.name, date_from, date_to)
    meta = {
        'report_name': 'Document Portal Inventory',
        'module': 'Document Portal',
        'generated_at': models.now().strftime('%Y-%m-%d %H:%M:%S IST'),
        'generated_by': _.full_name,
        'filters': f"Workspace: {workspace.name}; modified: {date_from or 'Beginning'} to {date_to or 'Now'}",
        'total_records': len(rows),
    }
    filename = f"document-portal-inventory_{models.today_ist().isoformat()}.{format}"
    if format == 'xlsx':
        body, media_type = _rows_to_xlsx(rows, meta), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    elif format == 'csv':
        body, media_type = iter([_rows_to_csv(rows, meta).getvalue().encode('utf-8')]), 'text/csv'
    else:
        body, media_type = _rows_to_pdf(rows, meta), 'application/pdf'
    return StreamingResponse(body, media_type=media_type,
                             headers={'Content-Disposition': f'attachment; filename="{filename}"'})


@router.post("/folders")
def create_folder(payload: FolderCreate, _: models.User = Depends(require_document_portal_contributor),
                  db: Session = Depends(get_db)):
    root, workspace = _scope(db, _)
    relative, parent = _path(payload.path, must_exist=True, root=root)
    if not parent.is_dir():
        raise _http_error("The parent path is not a folder.")
    name = _validate_name(payload.name)
    destination = parent / name
    try:
        destination.mkdir()
    except FileExistsError as exc:
        raise _http_error("An item with that name already exists.", 409) from exc
    item = _item(destination, root)
    logger.info("Document Portal folder created user=%s path=%s", _log_user(_), item["path"])
    return {"item": item, "parent_path": relative}


@router.post("/upload")
async def upload(
    path: str = Form(""),
    relative_path: str = Form(""),
    duplicate: Literal["keep", "replace", "cancel"] = Form("keep"),
    file: UploadFile = File(...),
    _: models.User = Depends(require_document_portal_contributor),
    db: Session = Depends(get_db),
):
    root, workspace = _scope(db, _)
    if workspace.document_portal_quota_bytes is None:
        raise _http_error('Ask an administrator to set this workspace’s Document Portal storage limit before uploading.', 409)
    base, folder = _path(path, must_exist=True, root=root)
    if not folder.is_dir():
        raise _http_error("The upload destination is not a folder.")
    relative = _relative(relative_path or file.filename or "")
    parts = list(Path(relative).parts)
    if not parts:
        raise _http_error("The uploaded file path is missing.")
    filename = _validate_name(parts[-1], is_file=True)
    directories = [_validate_name(part) for part in parts[:-1]]
    destination_relative = "/".join([part for part in [base, *directories] if part])
    _, destination_folder = _path(destination_relative, root=root)
    destination_folder.mkdir(parents=True, exist_ok=True)
    family_id, family_quota, family_roots = _quota_family(db, workspace)
    destination = await _store_file(destination_folder, file, filename, duplicate,
                                    root=root, quota_bytes=workspace.document_portal_quota_bytes,
                                    workspace_id=workspace.id, family_id=family_id,
                                    family_roots=family_roots, family_quota_bytes=family_quota, db=db)
    item = _item(destination, root)
    logger.info("Document Portal file uploaded user=%s path=%s size=%s duplicate=%s", _log_user(_), item["path"], item["size"], duplicate)
    return {"item": item, "saved_as": destination.name}


@router.post("/items/rename")
def rename(payload: RenameItem, _: models.User = Depends(require_document_portal_contributor),
           db: Session = Depends(get_db)):
    root, workspace = _scope(db, _)
    _, source = _path(payload.path, must_exist=True, root=root)
    if source == root or source.name == OWNER_FILE:
        raise _http_error("The workspace root cannot be renamed.")
    destination = source.with_name(_validate_name(payload.name, is_file=source.is_file()))
    if destination.exists():
        raise _http_error("An item with that name already exists.", 409)
    source.rename(destination)
    item = _item(destination, root)
    logger.info("Document Portal item renamed user=%s source=%s destination=%s", _log_user(_), payload.path, item["path"])
    return {"item": item}


@router.post("/items/move")
def move(payload: MoveItem, _: models.User = Depends(require_document_portal_contributor),
         db: Session = Depends(get_db)):
    root, workspace = _scope(db, _)
    _, source = _path(payload.path, must_exist=True, root=root)
    _, destination_folder = _path(payload.destination, must_exist=True, root=root)
    if source == root or source.name == OWNER_FILE:
        raise _http_error("The workspace root cannot be moved.")
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
    item = _item(target, root)
    logger.info("Document Portal item moved user=%s source=%s destination=%s", _log_user(_), payload.path, item["path"])
    return {"item": item}


@router.delete("/items")
def delete_item(
    path: str = Query(...),
    _: models.User = Depends(require_document_portal_manager),
    db: Session = Depends(get_db),
):
    root, workspace = _scope(db, _)
    relative, item = _path(path, must_exist=True, root=root)
    if item == root or item.name == OWNER_FILE:
        raise _http_error("The workspace root cannot be deleted.")
    is_folder = item.is_dir()
    if is_folder:
        shutil.rmtree(item)
    else:
        item.unlink()
    logger.warning(
        "Document Portal item deleted user=%s type=%s path=%s",
        _log_user(_),
        "folder" if is_folder else "file",
        relative,
    )
    return {"deleted": relative, "is_folder": is_folder}


@router.post("/delete-selection")
def delete_selection(payload: DownloadSelection,
                     _: models.User = Depends(require_document_portal_manager), db: Session = Depends(get_db)):
    root, workspace = _scope(db, _)
    _, current = _path(payload.current_path, must_exist=True, root=root)
    if not current.is_dir():
        raise _http_error("The current location is not a folder.")
    # Validate the entire selection before deleting any content.
    selected: dict[str, Path] = {}
    for value in payload.paths:
        relative, item = _path(value, must_exist=True, root=root)
        if item == root or item.name == OWNER_FILE:
            raise _http_error("The workspace root cannot be deleted.")
        if item.parent != current:
            raise _http_error("Selected items must belong to the current folder.")
        selected[relative] = item
    deleted = []
    failed = []
    for relative, item in selected.items():
        try:
            if item.is_dir():
                shutil.rmtree(item)
            else:
                item.unlink()
            deleted.append(relative)
            logger.warning("Document Portal item deleted user=%s workspace=%s path=%s",
                           _log_user(_), workspace.id, relative)
        except OSError:
            logger.exception("Document Portal deletion failed user=%s path=%s", _log_user(_), relative)
            failed.append(relative)
    return {"deleted": deleted, "failed": failed}


@router.get("/download")
def download(path: str = Query(...), _: models.User = Depends(require_document_portal_viewer),
             db: Session = Depends(get_db)):
    root, workspace = _scope(db, _)
    _, document = _path(path, must_exist=True, root=root)
    if document.name == OWNER_FILE:
        raise _http_error('The requested item was not found.', 404)
    if not document.is_file():
        raise _http_error("Select a file to download.")
    logger.info("Document Portal file download requested user=%s path=%s size=%s", _log_user(_), path, document.stat().st_size)
    return FileResponse(document, media_type=mimetypes.guess_type(document.name)[0] or "application/octet-stream", filename=document.name)


@router.get("/zip")
def download_folder_zip(background_tasks: BackgroundTasks, path: str = Query(""),
                        _: models.User = Depends(require_document_portal_viewer), db: Session = Depends(get_db)):
    root, workspace = _scope(db, _)
    _, folder = _path(path, must_exist=True, root=root)
    if not folder.is_dir():
        raise _http_error("Select a folder to download as ZIP.")
    archive = _archive([folder], folder.name or workspace.name)
    background_tasks.add_task(archive.unlink, missing_ok=True)
    logger.info("Document Portal folder ZIP download requested user=%s path=%s", _log_user(_), path or "<root>")
    return FileResponse(archive, media_type="application/zip", filename=f"{folder.name or 'document-portal'}.zip")


@router.post("/download-selection")
def download_selection(payload: DownloadSelection, background_tasks: BackgroundTasks,
                       _: models.User = Depends(require_document_portal_viewer), db: Session = Depends(get_db)):
    root, workspace = _scope(db, _)
    _, current = _path(payload.current_path, must_exist=True, root=root)
    if not current.is_dir():
        raise _http_error("The current location is not a folder.")
    selected: list[Path] = []
    seen: set[Path] = set()
    for value in payload.paths:
        _, item = _path(value, must_exist=True, root=root)
        if item.name == OWNER_FILE:
            raise _http_error('The requested item was not found.', 404)
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
            item.relative_to(root).as_posix(),
        )
        return FileResponse(item, media_type=mimetypes.guess_type(item.name)[0] or "application/octet-stream", filename=item.name)
    archive = _archive(selected, f"{current.name or 'document-portal'}-selection")
    background_tasks.add_task(archive.unlink, missing_ok=True)
    logger.info(
        "Document Portal selection ZIP download requested user=%s count=%s paths=%s",
        _log_user(_),
        len(selected),
        ",".join(item.relative_to(root).as_posix() for item in selected),
    )
    return FileResponse(archive, media_type="application/zip", filename=f"{current.name or 'document-portal'}-selection.zip")
