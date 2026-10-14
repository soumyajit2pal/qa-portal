"""Resolve explicitly selected evidence without granting verification credit."""
from fastapi import HTTPException
from . import documents


def selected_evidence(db, defect, document_ids):
    ids = list(dict.fromkeys(document_ids))
    if not ids:
        return [], None
    available = {doc.id: doc for doc in documents.list_documents(db, 'DEFECT', defect.id)}
    if any(identifier not in available for identifier in ids):
        raise HTTPException(400, 'Evidence must still be attached to this defect')
    snapshot = [{'id': identifier, 'file_name': available[identifier].file_name} for identifier in ids]
    return snapshot, 'Attached evidence: ' + ', '.join(item['file_name'] for item in snapshot)
