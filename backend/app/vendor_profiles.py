"""Organization identity metadata, independent of access/workflow authority."""
import json
import re
import unicodedata
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from . import models as m
from .audit_service import request_ip


def clean_name(value):
    name = ' '.join(unicodedata.normalize('NFKC', value).split())
    if not 2 <= len(name) <= 150 or re.search(r'[<>\x00-\x1f\x7f]', name):
        raise HTTPException(422, 'Enter an organization name of 2–150 characters without markup or control characters')
    return name, name.casefold()


def audit(db, actor, request, action, target, before=None, after=None, reason=None):
    # The profile/catalogue update and its immutable history commit together.
    db.add(m.AuditLog(event_type='ACCESS_MANAGEMENT', action=action, outcome='SUCCESS',
        actor_id=actor.id, actor_username=actor.username, actor_name=actor.full_name,
        actor_roles=actor.roles_csv, method=request.method, path=request.url.path,
        ip_address=request_ip(request), target_type='VENDOR_ORGANIZATION' if isinstance(target, m.VendorOrganization) else 'USER',
        target_id=str(target.id), target_name=target.name if isinstance(target, m.VendorOrganization) else target.full_name,
        details=json.dumps({'before': before, 'after': after, 'reason': reason})))


def organization_snapshot(row):
    return {'name': row.name, 'is_active': row.is_active, 'revision': row.revision}


def profile_snapshot(user):
    return {'user_type': user.user_type, 'vendor_organization_id': user.vendor_organization_id,
        'vendor_organization_name': user.vendor_organization_name, 'vendor_profile_exempt': bool(user.vendor_profile_exempt)}


def resolve_organization(db, actor, request, organization_id=None, organization_name=None):
    if organization_id is not None:
        # Serialize selection with deactivation; inactive existing affiliations
        # remain historical identity, but cannot be newly selected.
        row = db.query(m.VendorOrganization).filter_by(id=organization_id).with_for_update().one_or_none()
        if not row or not row.is_active:
            raise HTTPException(409, 'This organization is unavailable. Refresh the list and select an active organization.')
        return row
    name, normalized = clean_name(organization_name or '')
    row = db.query(m.VendorOrganization).filter_by(normalized_name=normalized).with_for_update().one_or_none()
    if row:
        if not row.is_active:
            raise HTTPException(409, 'This organization is inactive. Contact an Administrator to reactivate it.')
        return row
    try:
        with db.begin_nested():
            row = m.VendorOrganization(name=name, normalized_name=normalized, created_by_id=actor.id)
            db.add(row)
            db.flush()
    except IntegrityError:
        row = db.query(m.VendorOrganization).filter_by(normalized_name=normalized).with_for_update().one_or_none()
        if not row or not row.is_active:
            raise HTTPException(409, 'The organization list changed. Refresh and select the existing organization.')
        return row
    audit(db, actor, request, 'VENDOR_ORGANIZATION_CREATED', row, after=organization_snapshot(row))
    return row
