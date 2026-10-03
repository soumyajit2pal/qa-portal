"""Authenticated signature checks with the underlying record's read policy."""
import logging

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..constants import format_role_labels
from ..database import get_db
from ..deps import get_workflow_read_user as get_current_user
from ..pdf_export import parse_electronic_signature
from ..signature_integrity import (
    MAX_PDF_BYTES, approval_state, check_action, find_actions, inspect_pdf,
)
from ..time_format import as_ist, parse_timestamp
from .approvals import _comment_target_or_404, _resolve_request_ref

router = APIRouter(prefix="/api/signatures", tags=["signature-verification"])
logger = logging.getLogger("qa_portal.signature_verification")


class SignatureCheck(BaseModel):
    signature_id: str = Field(min_length=6, max_length=80, pattern=r"^ESIG-[A-Za-z0-9-]+$")


def _visible_action(db, user, action):
    if not action:
        raise HTTPException(404, "Signature not found in records you can access.")
    try:
        # Historical audit feeds can retain events for removed/private records.
        # Verification must follow the current entity read policy, including
        # private drafts, active delegates and the selected workspace.
        _comment_target_or_404(db, action.entity_type, action.entity_id, user)
    except HTTPException as exc:
        if exc.status_code in {400, 403, 404}:
            raise HTTPException(404, "Signature not found in records you can access.") from exc
        raise


def _result(db, action):
    status, message = check_action(action)
    result = {"status": status, "message": message}
    if status in {"VALID", "LEGACY", "UNVERIFIABLE"}:
        signature = parse_electronic_signature(action.comments, stage=action.step_name or "Approval")
        if signature:
            result.update(
                signature_id=signature.signature_id, signer=signature.signer,
                stage=action.step_name, decision=action.decision,
                actor_role=format_role_labels(action.actor_role), intent=signature.intent,
                request_ref=_resolve_request_ref(db, action.entity_type, action.entity_id),
                approval_state=approval_state(db, action),
            )
            signed_at = parse_timestamp(signature.applied_at)
            if signed_at is not None:
                result["signed_at"] = signed_at.isoformat()
            if action.created_at is not None:
                result["recorded_at"] = as_ist(action.created_at).isoformat()
    return result


@router.post("/check")
def check_signature(payload: SignatureCheck, response: Response,
                    db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    response.headers["Cache-Control"] = "no-store"
    rows = find_actions(db, payload.signature_id.upper())
    for row in rows:
        _visible_action(db, current_user, row)
    if not rows:
        raise HTTPException(404, "Signature not found in records you can access.")
    if len(rows) != 1:
        return {"status": "TAMPERED", "message": "This signature ID is associated with multiple approval records."}
    result = _result(db, rows[0])
    logger.info("Signature checked actor_id=%s approval_action_id=%s result=%s",
                current_user.id, rows[0].id, result["status"])
    return result


@router.post("/verify-pdf")
async def verify_pdf(response: Response, file: UploadFile = File(...),
                     db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    response.headers["Cache-Control"] = "no-store"
    try:
        data = await file.read(MAX_PDF_BYTES + 1)
    finally:
        await file.close()
    if len(data) > MAX_PDF_BYTES:
        raise HTTPException(413, "PDF must be 20 MB or smaller.")
    if not data.startswith(b"%PDF-"):
        raise HTTPException(400, "Choose a PDF exported from the portal.")
    status, message, proof = inspect_pdf(data)
    if proof is None:
        return {"status": status, "message": message, "signatures": []}
    results = []
    for evidence in proof["signatures"]:
        action = db.get(models.ApprovalAction, evidence["action_id"])
        _visible_action(db, current_user, action)
        if action.entity_type != proof["entity_type"] or action.entity_id != proof["entity_id"]:
            return {"status": "TAMPERED", "message": "The PDF no longer matches its original approval record.", "signatures": []}
        result = _result(db, action)
        if (result.get("signature_id") != evidence["signature_id"]
                or action.signature_seal != evidence["seal"]
                or action.signature_key_id != evidence["key_id"]):
            result = {"status": "TAMPERED", "message": "The original approval evidence has changed."}
        results.append(result)
    states = {item["status"] for item in results}
    if "TAMPERED" in states:
        status, message = "TAMPERED", "The document matches the export, but its recorded signature evidence has changed."
    elif "LEGACY" in states and states <= {"VALID", "LEGACY"}:
        status, message = "UNVERIFIABLE", "The PDF is unchanged since export. One or more older approval signatures have no original integrity seal, so changes since signing cannot be checked. Downloading a new PDF does not add an original seal to those approvals."
    elif states != {"VALID"}:
        status, message = "UNVERIFIABLE", "The document matches the export, but an original signature integrity seal or key is unavailable."
    logger.info("PDF integrity checked actor_id=%s entity_type=%s entity_id=%s result=%s",
                current_user.id, proof["entity_type"], proof["entity_id"], status)
    return {"status": status, "message": message, "document_intact": True, "signatures": results}
