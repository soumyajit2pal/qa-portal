from unittest.mock import MagicMock, patch

import json
from fastapi.responses import JSONResponse

from app import document_portal_main


def _database_session():
    session = MagicMock()
    manager = MagicMock()
    manager.__enter__.return_value = session
    manager.__exit__.return_value = False
    return manager


def test_document_portal_health_requires_database_and_storage():
    database = _database_session()
    storage_probe = MagicMock()
    storage_probe.__enter__.return_value = MagicMock()
    storage_probe.__exit__.return_value = False
    with patch.object(document_portal_main, "SessionLocal", return_value=database), \
         patch.object(document_portal_main.tempfile, "NamedTemporaryFile", return_value=storage_probe):
        result = document_portal_main.health()

    assert result["status"] == "ok"
    assert result["database"] == "ok"
    assert result["storage"] == "ok"


def test_document_portal_health_degrades_when_a_dependency_fails():
    with patch.object(document_portal_main, "SessionLocal", side_effect=RuntimeError("database down")), \
         patch.object(document_portal_main.tempfile, "NamedTemporaryFile", side_effect=PermissionError("read only")):
        response = document_portal_main.health()

    assert isinstance(response, JSONResponse)
    assert response.status_code == 503
    result = json.loads(response.body)
    assert result["status"] == "degraded"
    assert result["database"] == "unreachable"
    assert result["storage"] == "unwritable"
