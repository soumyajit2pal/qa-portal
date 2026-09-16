"""Workspace roots for the filesystem-backed Document Portal."""
import os
from pathlib import Path
from .storage_lock import exclusive_file_lock

from .config import settings


DEFAULT_DOCUMENT_ROOT = Path(__file__).resolve().parents[1] / 'uploads' / 'document_portal'
DOCUMENT_ROOT = Path(settings.document_portal_storage_host_path or DEFAULT_DOCUMENT_ROOT).expanduser().resolve()
OWNER_FILE = '.qualityops-workspace-id'
LAYOUT_READY = '.qualityops-layout-ready'
LEGACY_STAGE = '.qualityops-legacy-stage'


def workspace_folder_name(name: str) -> str:
    value = name.strip()
    if (not value or value in {'.', '..'} or len(value) > 150
            or any(char in value for char in '<>:"/\\|?*')
            or any(ord(char) < 32 for char in value) or value.endswith(('.', ' '))):
        raise ValueError('Workspace name cannot be used as a Document Portal folder name')
    return value


def workspace_root(workspace, *, repository_root: Path | None = None, create: bool = False) -> Path:
    root = (repository_root or DOCUMENT_ROOT).resolve()
    folder = root / workspace_folder_name(workspace.name)
    owner = folder / OWNER_FILE
    if folder.exists() or folder.is_symlink():
        if (folder.is_symlink() or not folder.is_dir() or owner.is_symlink()
                or not owner.is_file() or owner.read_text(encoding='utf-8').strip() != str(workspace.id)):
            raise FileExistsError(f'Document Portal folder "{workspace.name}" is already in use')
    elif create:
        root.mkdir(parents=True, exist_ok=True)
        folder.mkdir()
        owner.write_text(str(workspace.id), encoding='utf-8')
    return folder


def rename_workspace_root(workspace, new_name: str, *, repository_root: Path | None = None) -> tuple[Path, Path]:
    root = (repository_root or DOCUMENT_ROOT).resolve()
    old = workspace_root(workspace, repository_root=root, create=True)
    new = root / workspace_folder_name(new_name)
    if old == new:
        return old, new
    if new.exists():
        raise FileExistsError(f'Document Portal folder "{new_name}" is already in use')
    os.rename(old, new)
    return old, new


def prepare_existing_roots(db, *, repository_root: Path | None = None) -> None:
    """Create roots for old workspaces and preserve pre-workspace files in Default.

    Existing root-level content cannot reliably be attributed to a workspace.
    A visible Legacy Documents folder in the Default Workspace retains it.
    The staging directory makes an interrupted run resumable without deletion.
    """
    from . import models

    root = (repository_root or DOCUMENT_ROOT).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if (root / LAYOUT_READY).exists():
        return
    with exclusive_file_lock(root / '.qualityops-layout.lock') as acquired:
        if not acquired:
            raise RuntimeError('Document Portal workspace layout is being prepared. Retry shortly.')
        if (root / LAYOUT_READY).exists():
            return
        workspaces = db.query(models.QAWorkspace).order_by(models.QAWorkspace.id).all()
        known = {row.name: row.id for row in workspaces}
        stage = root / LEGACY_STAGE
        reserved = {LAYOUT_READY, LEGACY_STAGE, '.qualityops-layout.lock'}
        for entry in list(root.iterdir()):
            if entry.name in reserved or entry.name.startswith('.workspace-'):
                continue
            if entry.is_dir() and entry.name in known:
                owner = entry / OWNER_FILE
                if owner.is_file() and owner.read_text(encoding='utf-8').strip() == str(known[entry.name]):
                    continue
            stage.mkdir(exist_ok=True)
            destination = stage / entry.name
            number = 1
            while destination.exists():
                destination = stage / f'{entry.name} ({number})'
                number += 1
            entry.rename(destination)
        for workspace in workspaces:
            workspace_root(workspace, repository_root=root, create=True)
        if stage.exists() and any(stage.iterdir()):
            default = next((row for row in workspaces if row.is_default), None)
            if default is None:
                raise RuntimeError('Default Workspace is required to preserve legacy Document Portal files')
            legacy = workspace_root(default, repository_root=root) / 'Legacy Documents'
            legacy.mkdir(exist_ok=True)
            for entry in list(stage.iterdir()):
                destination = legacy / entry.name
                number = 1
                while destination.exists():
                    destination = legacy / f'{entry.name} ({number})'
                    number += 1
                entry.rename(destination)
        if stage.exists() and not any(stage.iterdir()):
            stage.rmdir()
        (root / LAYOUT_READY).write_text('workspace-scoped', encoding='utf-8')
