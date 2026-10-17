from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from .. import models as m, schemas
from ..constants import Role
from ..database import get_db
from ..deps import get_current_user, require_roles
from .. import vendor_profiles as service

router = APIRouter(tags=['Vendor organizations'])


class OrganizationOut(schemas.ORMModel):
    id: int
    name: str
    is_active: bool
    revision: int


class OrganizationSelection(BaseModel):
    model_config = ConfigDict(extra='forbid')
    organization_id: Optional[int] = Field(None, gt=0)
    organization_name: Optional[str] = Field(None, max_length=150)

    @model_validator(mode='after')
    def exactly_one(self):
        if (self.organization_id is not None) == (self.organization_name is not None):
            raise ValueError('Select an organization or enter a new organization name')
        return self


class OrganizationEdit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=2, max_length=150)
    is_active: bool
    expected_revision: int = Field(gt=0)
    reason: str = Field(min_length=5, max_length=1000)


class AdminProfile(BaseModel):
    model_config = ConfigDict(extra='forbid')
    organization_id: Optional[int] = Field(None, gt=0)
    organization_name: Optional[str] = Field(None, max_length=150)
    vendor_profile_exempt: bool = False
    expected_organization_id: Optional[int]
    expected_exempt: bool
    reason: str = Field(min_length=5, max_length=1000)

    @model_validator(mode='after')
    def valid_selection(self):
        if self.organization_id is not None and self.organization_name is not None:
            raise ValueError('Select an organization or enter a new name, not both')
        return self


@router.get('/api/vendor-organizations', response_model=list[OrganizationOut])
def list_organizations(include_inactive: bool = False, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    if include_inactive and not user.has_role(Role.ADMIN):
        raise HTTPException(403, 'Only Administrators can manage inactive organizations')
    query = db.query(m.VendorOrganization)
    if not include_inactive:
        query = query.filter_by(is_active=True)
    return query.order_by(m.VendorOrganization.normalized_name).all()


@router.post('/api/vendor-organizations', response_model=OrganizationOut)
def create_organization(body: OrganizationSelection, request: Request, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    if not user.has_role(Role.ADMIN) and not user.needs_vendor_organization:
        raise HTTPException(403, 'Organization creation is available during vendor setup or to Administrators')
    row = service.resolve_organization(db, user, request, body.organization_id, body.organization_name)
    db.commit()
    return row


@router.patch('/api/vendor-organizations/{organization_id}', response_model=OrganizationOut)
def edit_organization(organization_id: int, body: OrganizationEdit, request: Request, db: Session = Depends(get_db), user: m.User = Depends(require_roles(Role.ADMIN))):
    row = db.query(m.VendorOrganization).filter_by(id=organization_id).populate_existing().with_for_update().one_or_none()
    if not row:
        raise HTTPException(404, 'Organization not found')
    if row.revision != body.expected_revision:
        raise HTTPException(409, 'Organization changed. Refresh the list before editing again.')
    if len(body.reason.strip()) < 5:
        raise HTTPException(422, 'Enter the reason for this change')
    before = service.organization_snapshot(row)
    row.name, row.normalized_name = service.clean_name(body.name)
    row.is_active, row.revision, row.updated_at = body.is_active, row.revision + 1, m.now()
    try:
        db.flush()
        service.audit(db, user, request, 'VENDOR_ORGANIZATION_UPDATED', row, before, service.organization_snapshot(row), body.reason.strip())
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, 'An organization with this name already exists')
    return row


@router.patch('/api/auth/me/vendor-organization', response_model=schemas.UserOut)
def complete_profile(body: OrganizationSelection, request: Request, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    user = db.query(m.User).filter_by(id=user.id).populate_existing().with_for_update().one()
    if not user.needs_vendor_organization:
        raise HTTPException(409, 'Organization setup is already complete or does not apply. Contact an Administrator for corrections.')
    before = service.profile_snapshot(user)
    user.vendor_organization = service.resolve_organization(db, user, request, body.organization_id, body.organization_name)
    db.flush()
    service.audit(db, user, request, 'VENDOR_PROFILE_COMPLETED', user, before, service.profile_snapshot(user))
    db.commit()
    return user


@router.patch('/api/auth/users/{user_id}/vendor-profile', response_model=schemas.UserOut)
def admin_profile(user_id: int, body: AdminProfile, request: Request, db: Session = Depends(get_db), actor: m.User = Depends(require_roles(Role.ADMIN))):
    user = db.query(m.User).filter_by(id=user_id).populate_existing().with_for_update().one_or_none()
    if not user:
        raise HTTPException(404, 'User not found')
    if user.user_type != 'VENDOR':
        raise HTTPException(400, 'Vendor profiles apply only to vendor LDAP accounts. Standard and Bank Staff accounts are unchanged.')
    if (body.expected_organization_id, body.expected_exempt) != (user.vendor_organization_id, bool(user.vendor_profile_exempt)):
        raise HTTPException(409, 'This profile changed. Reopen the user before saving again.')
    if len(body.reason.strip()) < 5:
        raise HTTPException(422, 'Enter the administrative reason')
    before = service.profile_snapshot(user)
    if body.organization_id is not None and body.organization_id == user.vendor_organization_id:
        pass
    elif body.organization_id is not None or body.organization_name is not None:
        user.vendor_organization = service.resolve_organization(db, actor, request, body.organization_id, body.organization_name)
    else:
        user.vendor_organization = None
    user.vendor_profile_exempt = body.vendor_profile_exempt
    db.flush()
    service.audit(db, actor, request, 'VENDOR_PROFILE_ADMIN_UPDATED', user, before, service.profile_snapshot(user), body.reason.strip())
    db.commit()
    return user
