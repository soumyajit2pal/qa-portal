"""Certificate authorship is distinct from the user exporting a PDF copy."""
import json

from fastapi import HTTPException

from . import models


ACCOUNT_TYPE_LABELS = {
    'BANK_STAFF': 'Bank Staff',
    'VENDOR': 'Vendor',
    'STANDARD': 'Standard account',
}
_LIVE_PREPARER_STATUSES = {
    'DRAFT', 'SUBMITTED', 'SM_APPROVAL_PENDING', 'RETURNED_BY_SM',
    'DEPT_HEAD_QA_APPROVAL_PENDING', 'RETURNED_BY_DEPT_HEAD_COE',
    'RETURNED_BY_REQUESTER',
}


def user_identity(user):
    """Read authoritative account classification, never infer it in the UI."""
    return {
        'user_id': user.id,
        'full_name': user.full_name or user.username,
        'username': user.username,
        'user_type': user.user_type,
        'vendor_organization_id': user.vendor_organization_id if user.user_type == 'VENDOR' else None,
        'vendor_organization_name': user.vendor_organization_name if user.user_type == 'VENDOR' else None,
    }


def preparer_for(obj):
    envelope = json.loads(obj.certificate_data_json or '{}')
    frozen = envelope.get('prepared_by')
    if frozen:
        return {**frozen, 'is_frozen': True}
    # A historical document must never acquire today's name or affiliation.
    if obj.status not in _LIVE_PREPARER_STATUSES or obj.requester is None:
        return None
    return {**user_identity(obj.requester), 'captured_at': None, 'is_frozen': False}


def freeze_preparer(db, obj):
    """Called inside final approval's existing transaction, before issuance.

    Use the current certificate owner (including a governed takeover), and
    retain the reviewed evidence and revision history unchanged as JSON values.
    A successor starts with its own envelope and captures its own preparer.
    """
    envelope = json.loads(obj.certificate_data_json or '{}')
    if envelope.get('prepared_by'):
        return envelope['prepared_by']
    if obj.status != 'DEPT_HEAD_QA_APPROVAL_PENDING':
        raise HTTPException(409, 'Preparer identity can only be recorded during final certificate approval')
    owner = (db.query(models.User).filter(models.User.id == obj.requester_id)
             .populate_existing().with_for_update().one_or_none())
    if owner is None:
        raise HTTPException(409, 'The certificate preparer is unavailable. Return the certificate for ownership correction before issuing it.')
    identity = {**user_identity(owner), 'captured_at': models.now().isoformat()}
    envelope['prepared_by'] = identity
    obj.certificate_data_json = json.dumps(envelope)
    return identity


def export_identity_label(user):
    identity = user_identity(user)
    parts = [f"{identity['full_name']} (@{identity['username']})", ACCOUNT_TYPE_LABELS[identity['user_type']]]
    if identity['user_type'] == 'VENDOR':
        parts.append(identity['vendor_organization_name'] or 'Organization not provided')
    return ' · '.join(parts)
