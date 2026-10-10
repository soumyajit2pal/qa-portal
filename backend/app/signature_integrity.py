"""Server-sealed approval evidence and exact-byte PDF integrity proofs."""
import base64
import hashlib
import hmac
import io
import json
import re
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select

from .config import settings
from .pdf_export import _ELECTRONIC_SIGNATURE, parse_electronic_signature
from .time_format import as_ist

PDF_MARKER = b"\n%QualityOps-Integrity-v1 "
MAX_PDF_BYTES = 20 * 1024 * 1024
MAX_PROOF_BYTES = 128 * 1024


def _key():
    secret = settings.signature_integrity_key or settings.secret_key
    key = hmac.new(secret.encode(), b"QualityOps signature integrity v1", hashlib.sha256).digest()
    return key, hashlib.sha256(key).hexdigest()[:16]


def _canonical(payload):
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _seal(payload):
    return hmac.new(_key()[0], _canonical(payload), hashlib.sha256).hexdigest()


def action_payload(action):
    payload = {
        "kind": "approval", "version": 1, "signature_id": action.signature_id,
        "entity_type": action.entity_type or None, "entity_id": action.entity_id,
        "stage": action.step_name or None, "actor_id": action.actor_id, "actor_role": action.actor_role or None,
        "decision": action.decision or None, "comments": action.comments,
        # Oracle DATE drops fractional seconds; canonicalize at that precision.
        "recorded_at": as_ist(action.created_at).replace(microsecond=0).isoformat(),
        "previous_state": action.previous_state or None, "new_state": action.new_state or None,
    }
    # Legacy seals were created before this additive review identity existed.
    # Preserve their payload, while binding new name-review seals to the name.
    if getattr(action, "application_master_id", None) is not None:
        payload["application_master_id"] = action.application_master_id
    return payload


def seal_new_action(connection, action):
    """Run only on INSERT, never re-sign an altered historical record."""
    from . import models
    marker = "[Electronic signature |"
    if marker not in (action.comments or ""):
        return
    matches = list(_ELECTRONIC_SIGNATURE.finditer(action.comments))
    if len(matches) != 1 or action.comments.count(marker) != 1:
        raise HTTPException(400, "Electronic signature evidence is malformed or ambiguous.")
    signature = parse_electronic_signature(action.comments)
    try:
        if not signature.signature_id.startswith("ESIG-"):
            raise ValueError()
        identifier = "ESIG-" + str(UUID(signature.signature_id[5:])).upper()
    except (ValueError, AttributeError):
        raise HTTPException(400, "Electronic signature ID is invalid.")
    if not (action.decision or "").lower().startswith(("approved", "recommended")):
        raise HTTPException(400, "Electronic signatures can only accompany an approval decision.")
    signer = connection.execute(select(models.User.full_name).where(models.User.id == action.actor_id)).scalar_one_or_none()
    if not signer:
        raise HTTPException(400, "An authenticated approver is required to record a signature.")
    if connection.execute(select(models.ApprovalAction.id).where(models.ApprovalAction.signature_id == identifier)).first():
        raise HTTPException(409, "This signature has already been used. Apply a new signature.")
    legacy_comments = connection.execute(select(models.ApprovalAction.comments).where(
        models.ApprovalAction.signature_id.is_(None),
        models.ApprovalAction.comments.contains(f"Signature ID: {identifier} |", autoescape=True),
        models.ApprovalAction.comments.contains(marker, autoescape=True),
    )).scalars()
    if any((legacy := parse_electronic_signature(comments)) and legacy.signature_id == identifier
           for comments in legacy_comments):
        raise HTTPException(409, "This signature has already been used. Apply a new signature.")
    # Use the persisted actor and server clock, never browser-supplied identity/time.
    parts = signer.strip().rsplit(None, 3)
    if len(parts) == 4 and parts[1].lower() == "of" and parts[2].lower() == "req" and parts[3].isdigit():
        signer = parts[0]
    signer = signer.replace("|", "/").replace("[", "(").replace("]", ")")
    # Persist the IST wall clock too: Oracle DATE discards timezone offsets.
    # Sealing an aware UTC timestamp without converting the stored value
    # would make a fresh signature fail verification after the first reload.
    action.created_at = as_ist(action.created_at or models.now())
    recorded_at = as_ist(action.created_at).replace(microsecond=0).isoformat()
    evidence = (
        f"[Electronic signature | Signer: {signer} | Applied: {recorded_at} "
        f"| Signature ID: {identifier} | Style: {signature.style} | Intent: {signature.intent}]"
    )
    match = matches[0]
    action.comments = action.comments[:match.start()] + evidence + action.comments[match.end():]
    action.signature_id = identifier
    action.signature_key_id = _key()[1]
    action.signature_seal = _seal(action_payload(action))


def check_action(action):
    signature = parse_electronic_signature(action.comments, stage=action.step_name or "Approval")
    if not action.signature_seal:
        if action.signature_id or action.signature_key_id:
            return "TAMPERED", "The original signature seal is missing."
        return "LEGACY", "This older approval has no original integrity seal. The record exists, but changes since signing cannot be checked. Only signatures recorded with integrity protection can be fully verified."
    if action.signature_key_id != _key()[1]:
        return "UNVERIFIABLE", "The original verification key is unavailable."
    try:
        valid = hmac.compare_digest(action.signature_seal, _seal(action_payload(action)))
    except (TypeError, ValueError, AttributeError):
        valid = False
    if not valid or not signature or signature.signature_id != action.signature_id:
        return "TAMPERED", "The recorded signature or approval evidence has changed."
    return "VALID", "The signer, decision and recorded approval evidence match their original integrity seal."


def find_actions(db, identifier):
    from . import models
    rows = db.query(models.ApprovalAction).filter(models.ApprovalAction.signature_id == identifier).limit(2).all()
    if len(rows) > 1:
        return rows
    # Older records have no indexed signature ID. Never seal them retroactively.
    candidates = db.query(models.ApprovalAction).filter(
        models.ApprovalAction.signature_id.is_(None),
        models.ApprovalAction.comments.contains(f"Signature ID: {identifier} |", autoescape=True),
        models.ApprovalAction.comments.contains("[Electronic signature |", autoescape=True),
    ).yield_per(100)
    for row in candidates:
        signature = parse_electronic_signature(row.comments)
        if signature and signature.signature_id == identifier:
            rows.append(row)
            if len(rows) > 1:
                break
    return rows


def approval_state(db, action):
    from . import models
    later = db.query(models.ApprovalAction).filter(
        models.ApprovalAction.entity_type == action.entity_type,
        models.ApprovalAction.entity_id == action.entity_id,
        models.ApprovalAction.id > action.id,
    ).all()
    if any(row.decision == "Approval reset" or (row.step_name == "Requester Verification" and row.decision == "Changes Required") for row in later):
        return "RESET"
    if any(row.step_name == action.step_name and parse_electronic_signature(row.comments) for row in later):
        return "REPLACED"
    if action.entity_type == "SIGNOFF":
        record = db.get(models.QASignOff, action.entity_id)
        if record and record.status == "ISSUED_UNDER_REVIEW":
            return "ON_HOLD"
        if record and record.status in {"SUPERSEDED", "VOIDED", "REJECTED", "SM_REJECTED", "DEPT_HEAD_COE_REJECTED"}:
            return "HISTORICAL"
    return "CURRENT"


def protect_pdf(data, *, db, entity_type, entity_id, signature_ids):
    from . import models
    rows = db.query(models.ApprovalAction).filter_by(entity_type=entity_type, entity_id=entity_id).all()
    evidence = []
    for identifier in sorted(signature_ids):
        matches = [row for row in rows if (signature := parse_electronic_signature(row.comments))
                   and signature.signature_id == identifier]
        if len(matches) != 1:
            raise HTTPException(409, "Signature evidence is missing or ambiguous. Export cannot be verified.")
        action = matches[0]
        state, _ = check_action(action)
        if state not in {"VALID", "LEGACY"}:
            raise HTTPException(409, "Signature integrity could not be confirmed. Export cannot be verified.")
        evidence.append({"action_id": action.id, "signature_id": identifier,
                         "seal": action.signature_seal, "key_id": action.signature_key_id})
    payload = {"kind": "pdf", "version": 1, "key_id": _key()[1],
               "sha256": hashlib.sha256(data).hexdigest(), "entity_type": entity_type,
               "entity_id": entity_id, "signatures": evidence}
    token = base64.urlsafe_b64encode(_canonical(payload)).rstrip(b"=") + b"." + _seal(payload).encode()
    if len(token) > MAX_PROOF_BYTES:
        raise HTTPException(409, "Too many signature records to include in this PDF.")
    return io.BytesIO(data + PDF_MARKER + token + b"\n")


def inspect_pdf(data):
    """Validate the signed manifest and every original byte before trusting it."""
    body, marker, token = data.rpartition(PDF_MARKER)
    if not marker:
        return "UNVERIFIABLE", "This PDF has no portal integrity proof. Download a new PDF from the portal.", None
    if len(token) > MAX_PROOF_BYTES or not re.fullmatch(rb"[A-Za-z0-9_-]+\.[a-f0-9]{64}\n", token):
        return "TAMPERED", "The PDF integrity proof has been changed or is incomplete.", None
    encoded, tag = token[:-1].split(b".")
    try:
        payload = json.loads(base64.urlsafe_b64decode(encoded + b"=" * (-len(encoded) % 4)))
        if not isinstance(payload, dict) or payload.get("kind") != "pdf" or payload.get("version") != 1:
            raise ValueError()
        if payload.get("key_id") != _key()[1]:
            return "UNVERIFIABLE", "The original PDF verification key is unavailable.", None
        if not hmac.compare_digest(tag.decode(), _seal(payload)):
            raise ValueError()
        if not hmac.compare_digest(payload["sha256"], hashlib.sha256(body).hexdigest()):
            raise ValueError()
        if not isinstance(payload.get("signatures"), list) or not payload["signatures"]:
            raise ValueError()
        return "VALID", "The uploaded PDF matches the exact document exported by the portal.", payload
    except (ValueError, KeyError, TypeError, UnicodeError, RecursionError):
        return "TAMPERED", "The PDF or its integrity proof has been changed.", None
