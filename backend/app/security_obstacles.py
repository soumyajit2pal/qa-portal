"""Scoped post-readiness returns, internal holds and independent fresh review."""
import json
from collections import Counter
from urllib.parse import urlsplit, urlunsplit

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from . import models, schemas
from .constants import Role, POST_SIT_ENVIRONMENTS
from .database import get_db
from .deps import get_workflow_user, require_same_department, require_not_requester, require_department_unit_action_scope
from .security_scan_state import active_obstacles, OBSTACLE_STATES
from .workflow_authority import workflow_context

ACTIVE_STAGES = {"PLANNING", "CONFIGURATION", "SCANNING", "FINDING_VALIDATION", "REMEDIATION",
                 "ASSIGNED_TO_REQUESTER", "WAITING_FOR_FIX", "ASSIGNED_TO_LEAD", "RESCAN"}
LEAD_ROLES = (Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)
SAST_FIELDS = {"repository_url", "git_branch", "commit_id", "technology_stack", "build_number"}
DAST_FIELDS = {"application_url", "environment", "authentication_required", "test_credentials", "commit_id"}
SCOPE_FIELDS = {"repository_url", "git_branch", "technology_stack", "application_url", "environment", "authentication_required"}


def repository_identity(repository_url, branch):
    """Compare clone references while preserving path and branch case."""
    reference = (repository_url or "").strip().rstrip("/")
    try:
        parts = urlsplit(reference)
        if parts.scheme.lower() in {"http", "https", "ssh", "git"} and parts.hostname:
            host = parts.hostname.lower()
            if ":" in host:
                host = f"[{host}]"
            default_port = {"http": 80, "https": 443, "ssh": 22, "git": 9418}.get(parts.scheme.lower())
            if parts.port and parts.port != default_port:
                host += f":{parts.port}"
            path = parts.path.rstrip("/").removesuffix(".git")
            reference = urlunsplit((parts.scheme.lower(), host, path, parts.query, ""))
        else:
            reference = reference.removesuffix(".git")
    except ValueError:
        # Nonstandard repository references remain advisory, as at intake.
        reference = reference.removesuffix(".git")
    return reference, (branch or "").strip()


def _workflow():
    from .routers import sast_dast
    return sast_dast


def _rows(obj):
    return obj.components if isinstance(obj, models.SASTRequest) else obj.targets


def _reviewer(obj, user):
    if set(user.roles) & {Role.VIEW_ONLY, Role.SCALE_6_PLUS}:
        return False
    workspace_id = obj.qa_workspace_id
    return bool(user.has_role(Role.ADMIN) or
                (obj.security_analyst_id == user.id and user.has_qa_workspace_role(Role.SECURITY_ANALYST, workspace_id=workspace_id)) or
                user.has_qa_workspace_role(*LEAD_ROLES, workspace_id=workspace_id))


def _require_reviewer(obj, user):
    if not _reviewer(obj, user):
        raise HTTPException(403, "Only the assigned Security Analyst or a QA Lead in this workspace can perform this action")


def _input_owner(obj):
    return obj.active_delegation.assigned_to_id if obj.active_delegation else obj.requester_id


def _hold_owner(db, obj, owner_id):
    owner = db.get(models.User, owner_id) if owner_id else None
    eligible = False
    if owner and owner.is_active and owner.show_in_user_dropdowns:
        with workflow_context(owner):
            eligible = not (set(owner.roles) & {Role.VIEW_ONLY, Role.SCALE_6_PLUS}) and owner.has_qa_workspace_role(
                Role.SECURITY_ANALYST, *LEAD_ROLES, workspace_id=obj.qa_workspace_id, allow_admin=False)
    if not eligible:
        raise HTTPException(400, "Internal hold owner must be an active Security Analyst or QA Lead in this workspace")
    return owner


def _load(db, cls, req_id, user):
    obj = _workflow()._get_or_404(db, cls, req_id, "Security", lock=True)
    _workflow()._require_visible(db, obj, user)
    return obj


def _obstacle(obj, obstacle_id, revision):
    row = next((row for row in obj.obstacles if row.id == obstacle_id), None)
    if row is None:
        raise HTTPException(404, "Obstacle not found on this request")
    if row.revision != revision:
        raise HTTPException(409, {"code": "STALE_SECURITY_OBSTACLE", "message": "This obstacle changed. Refresh it before submitting or reviewing again."})
    return row


def _audit(db, obj, row, user, decision, previous, comments=None):
    # Credentials never enter obstacle metadata, audit history or email.
    targets = row.target_ids or [target.id for target in _rows(obj)]
    details = f"Obstacle #{row.id}; {row.kind}; affected target IDs: {targets}; resume stage: {row.resume_stage}."
    if row.changed_fields:
        details += " Changed fields: " + ", ".join(row.changed_fields) + "."
    db.add(models.ApprovalAction(entity_type="SAST" if isinstance(obj, models.SASTRequest) else "DAST",
        entity_id=obj.id, step_name=f"Security obstacle #{row.id}", actor_id=user.id,
        actor_role=user.roles_csv, decision=decision, previous_state=previous, new_state=row.status,
        comments=details + ("\n" + comments if comments else "")))
    obj.updated_at = models.now()


def _refresh(db, obj, resume_stage=None):
    # A whole-request pause remembers the real working stage, never a pause
    # label. Partial holds retain independent progress for unaffected targets.
    if obj.status in OBSTACLE_STATES:
        obj.status = resume_stage or next((row.resume_stage for row in active_obstacles(obj)), "CONFIGURATION")
    if obj.status == "PLANNING" and obj.security_analyst_id:
        obj.status = "CONFIGURATION"
    _workflow()._security_aggregate_status(db, obj)
    if not _rows(obj) and active_obstacles(obj):
        from .security_scan_state import obstacle_state
        obj.status = obstacle_state(active_obstacles(obj)[0])


def _save(db, obj, user, *, commit=True):
    if commit:
        db.commit()
        db.refresh(obj)
    else:
        db.flush()
    return _workflow()._dast_out(obj, user) if isinstance(obj, models.DASTRequest) else schemas.SASTOut.model_validate(obj)


def create_obstacle(db, cls, req_id, payload, user, *, commit=True):
    obj = _load(db, cls, req_id, user)
    _require_reviewer(obj, user)
    if obj.status not in ACTIVE_STAGES:
        raise HTTPException(400, "Returns and holds are available only during active post-readiness work")
    if payload.allow_scope_additions and (cls is not models.SASTRequest or payload.kind != "REQUESTER"):
        raise HTTPException(400, "Repository additions can be permitted only for SAST requester returns")
    selected = set(payload.target_ids)
    if len(selected) != len(payload.target_ids):
        raise HTTPException(400, "Select each repository or target only once")
    known = {target.id for target in _rows(obj)}
    if not selected <= known:
        raise HTTPException(400, "Every selected repository or target must belong to this request")
    for pending in active_obstacles(obj):
        if not selected or not pending.target_ids or selected.intersection(pending.target_ids):
            raise HTTPException(409, "An active obstacle already covers this scope. Resolve and review it first.")
    owner_id = _input_owner(obj)
    if payload.kind == "INTERNAL":
        owner_id = payload.owner_id or obj.security_analyst_id or user.id
        _hold_owner(db, obj, owner_id)
    elif payload.owner_id is not None:
        raise HTTPException(400, "Requester returns follow the requester or active delegate; their owner cannot be overridden")
    if not owner_id:
        raise HTTPException(400, "An accountable action owner is required")
    row = models.SecurityObstacle(kind=payload.kind, status="OPEN", revision=1,
        category=payload.category, reason=payload.reason, requested_correction=payload.requested_correction,
        target_ids_json=json.dumps(payload.target_ids), changed_fields_json="[]", resume_stage=obj.status,
        owner_id=owner_id, opened_by_id=user.id, readiness_required=False,
        reapproval_required=payload.require_dept_head_reapproval, allow_scope_additions=payload.allow_scope_additions)
    obj.obstacles.append(row)
    db.flush()
    _refresh(db, obj)
    permission = "\nQA permits repository additions within this return." if row.allow_scope_additions else ""
    _audit(db, obj, row, user, "Obstacle returned to requester" if row.kind == "REQUESTER" else "Internal hold opened", "", payload.reason + "\nRequired action: " + payload.requested_correction + permission)
    return _save(db, obj, user, commit=commit)


def set_scope_permission(db, cls, req_id, obstacle_id, payload, user):
    obj = _load(db, cls, req_id, user)
    _require_reviewer(obj, user)
    row = _obstacle(obj, obstacle_id, payload.revision)
    if cls is not models.SASTRequest or row.kind != "REQUESTER" or row.status != "OPEN" or not row.target_ids:
        raise HTTPException(400, "Scope permission applies only to an open SAST return covering selected repositories")
    if row.allow_scope_additions == payload.allow_scope_additions:
        raise HTTPException(400, "The repository addition permission is already set to that value")
    row.allow_scope_additions = payload.allow_scope_additions
    row.revision += 1
    _audit(db, obj, row, user, "Repository addition permission changed", "OPEN",
        f"Allow additions: {row.allow_scope_additions}. Reason: {payload.reason}")
    return _save(db, obj, user)


def route_obstacle(db, cls, req_id, obstacle_id, payload, user):
    """Recover an unavailable owner or a mistaken return without deleting scope."""
    obj = _load(db, cls, req_id, user)
    _require_reviewer(obj, user)
    row = _obstacle(obj, obstacle_id, payload.revision)
    if row.status != "OPEN":
        raise HTTPException(400, "Only an open obstacle can change routing. Return a pending correction before rerouting it.")
    if payload.kind == "INTERNAL":
        owner_id = payload.owner_id or obj.security_analyst_id or user.id
        _hold_owner(db, obj, owner_id)
    else:
        if payload.owner_id is not None:
            raise HTTPException(400, "Requester routing follows the requester or active delegate")
        owner_id = _input_owner(obj)
        if not owner_id:
            raise HTTPException(400, "A requester or active delegate is required")
    previous = f"{row.kind}; owner {row.owner_id}"
    if row.kind == payload.kind and row.owner_id == owner_id:
        raise HTTPException(400, "The obstacle already has this routing and owner")
    row.kind = payload.kind
    row.owner_id = owner_id
    if row.kind == "INTERNAL":
        row.allow_scope_additions = False
    row.revision += 1
    _refresh(db, obj, row.resume_stage)
    _audit(db, obj, row, user, "Obstacle routing changed", previous,
        f"New routing: {row.kind}; owner {row.owner_id}. Reason: {payload.reason}. Fresh submission and independent QA review remain required.")
    return _save(db, obj, user)


def submit_obstacle(db, cls, req_id, obstacle_id, payload, user):
    obj = _load(db, cls, req_id, user)
    row = _obstacle(obj, obstacle_id, payload.revision)
    if set(user.roles) & {Role.VIEW_ONLY, Role.SCALE_6_PLUS}:
        raise HTTPException(403, "Read-only users cannot submit obstacle corrections")
    if row.status != "OPEN":
        raise HTTPException(400, "Only an open obstacle can be submitted for review")
    owner_id = _input_owner(obj) if row.kind == "REQUESTER" else row.owner_id
    if user.id != owner_id:
        raise HTTPException(403, "Only this obstacle's current action owner can submit its resolution")
    if row.kind == "INTERNAL" and (payload.corrections or payload.new_repositories):
        raise HTTPException(400, "Internal hold resolution cannot change requester inputs; use a requester return for input corrections")
    if payload.new_repositories:
        if cls is not models.SASTRequest:
            raise HTTPException(400, "Repository additions are available only for SAST requester corrections")
        if row.target_ids and not row.allow_scope_additions:
            raise HTTPException(403, "QA must permit additions before expanding a return limited to selected repositories")
        if not payload.scope_change_reason:
            raise HTTPException(400, "A reason is required when adding repositories to approved scope")
    by_id = {target.id: target for target in _rows(obj)}
    allowed_ids = set(row.target_ids) if row.target_ids else set(by_id)
    allowed_fields = SAST_FIELDS if cls is models.SASTRequest else DAST_FIELDS
    selected_ids, changes = set(), []
    prospective_repositories = {target.id: {field: getattr(target, field) for field in SAST_FIELDS} for target in _rows(obj)} if cls is models.SASTRequest else {}
    changed_identities = set()
    # Preflight every patch before modifying a single row.
    for correction in payload.corrections:
        if correction.target_id in selected_ids or correction.target_id not in allowed_ids or correction.target_id not in by_id:
            raise HTTPException(400, "Corrections must name unique existing targets covered by this obstacle")
        selected_ids.add(correction.target_id)
        fields = correction.model_fields_set - {"target_id"}
        if not fields <= allowed_fields:
            raise HTTPException(400, "Correction fields do not match this request's scan type")
        target = by_id[correction.target_id]
        prospective = {field: getattr(correction, field) if field in fields else getattr(target, field) for field in allowed_fields}
        if cls is models.SASTRequest:
            prospective_repositories[target.id] = prospective
            if repository_identity(prospective["repository_url"], prospective["git_branch"]) != repository_identity(target.repository_url, target.git_branch):
                changed_identities.add(target.id)
        required = SAST_FIELDS if cls is models.SASTRequest else {"application_url", "environment", "authentication_required"}
        if any(not prospective[field] or not prospective[field].strip() for field in required):
            raise HTTPException(400, "Corrected scope must include all required repository/target inputs")
        if cls is models.DASTRequest and prospective["authentication_required"] == "Yes" and not (prospective["test_credentials"] or "").strip():
            raise HTTPException(400, "Test credentials are required for authenticated DAST targets")
        if cls is models.DASTRequest and "environment" in fields and prospective["environment"] not in POST_SIT_ENVIRONMENTS:
            raise HTTPException(400, "DAST environment must be UAT or Pre-Production, as on the request creation form")
        for field in fields:
            value = getattr(correction, field)
            if value != getattr(target, field):
                changes.append((target, field, value))
    if cls is models.SASTRequest:
        identities = {target_id: repository_identity(values["repository_url"], values["git_branch"]) for target_id, values in prospective_repositories.items()}
        counts = Counter(identities.values())
        if any(counts[identities[target_id]] > 1 for target_id in changed_identities):
            raise HTTPException(409, "A corrected repository and branch duplicate another repository in this request")
        known = set(identities.values())
        for repository in payload.new_repositories:
            identity = repository_identity(repository.repository_url, repository.git_branch)
            if identity in known:
                raise HTTPException(409, "Each repository and branch must be unique across existing and new repositories")
            known.add(identity)
    changed_fields = set(row.changed_fields)
    for target, field, value in changes:
        setattr(target, field, value)
        changed_fields.add(f"Target {target.id}: {field}")
        # Keep old scan pointers/history, but prevent old evidence clearing
        # changed input identity (including authenticated coverage).
        target.scan_state = "STALE"
        if field in SCOPE_FIELDS:
            row.readiness_required = True
            row.reapproval_required = True
    added = []
    for repository in payload.new_repositories:
        target = models.SASTComponent(**repository.model_dump(), scan_state="NOT_SCANNED")
        obj.components.append(target)
        added.append(target)
    if added:
        db.flush()
        new_ids = [target.id for target in added]
        row.added_target_ids_json = json.dumps([*row.added_target_ids, *new_ids])
        if row.target_ids:
            row.target_ids_json = json.dumps([*row.target_ids, *new_ids])
        changed_fields.update(f"Target {target.id}: repository added" for target in added)
        row.readiness_required = True
        row.reapproval_required = True
    row.changed_fields_json = json.dumps(sorted(changed_fields))
    row.resolution = payload.resolution or None
    row.owner_id = owner_id
    row.submitted_by_id = user.id
    row.submitted_at = models.now()
    row.reviewed_by_id = None
    row.reviewed_at = None
    row.status = "SCOPE_APPROVAL_PENDING" if row.reapproval_required else "QA_REVIEW_PENDING"
    row.revision += 1
    _refresh(db, obj, row.resume_stage)
    audit_notes = row.resolution or ""
    if added:
        audit_notes += f"\nScope addition reason: {payload.scope_change_reason}. New repository IDs: {[target.id for target in added]}. New repositories require scope approval, fresh QA readiness review and their own scan."
    _audit(db, obj, row, user, "Obstacle resolution submitted", "OPEN", audit_notes.strip())
    return _save(db, obj, user)


def approve_obstacle(db, cls, req_id, obstacle_id, payload, user):
    obj = _load(db, cls, req_id, user)
    row = _obstacle(obj, obstacle_id, payload.revision)
    if row.status != "SCOPE_APPROVAL_PENDING":
        raise HTTPException(400, "Scope reapproval is not pending")
    if not user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM):
        raise HTTPException(403, "Only a Department Head can approve changed scope")
    require_same_department(user, obj.department)
    require_department_unit_action_scope(db, user, obj.department, obj.qa_request.department_unit_id if obj.qa_request else None)
    require_not_requester(user, obj.requester_id)
    _workflow()._require_distinct_department_head_approver(db, obj, user)
    if user.id == row.submitted_by_id:
        raise HTTPException(403, "Changed scope must be approved by a different person")
    if payload.decision == "Return" and not payload.comments:
        raise HTTPException(400, "A reason is required when returning changed scope")
    if payload.decision == "Approve" and obj.application_master_status not in (None, "APPROVED"):
        raise HTTPException(400, "Application approval is required before approving changed scope")
    previous = row.status
    row.status = "QA_REVIEW_PENDING" if payload.decision == "Approve" else "OPEN"
    if payload.decision == "Approve":
        row.reapproval_required = False
    row.revision += 1
    _refresh(db, obj, row.resume_stage)
    _audit(db, obj, row, user, "Obstacle scope approved" if payload.decision == "Approve" else "Obstacle scope returned", previous, payload.comments)
    return _save(db, obj, user)


def review_obstacle(db, cls, req_id, obstacle_id, payload, user):
    obj = _load(db, cls, req_id, user)
    row = _obstacle(obj, obstacle_id, payload.revision)
    _require_reviewer(obj, user)
    if row.status != "QA_REVIEW_PENDING":
        raise HTTPException(400, "Submit the correction and complete any scope reapproval before fresh QA review")
    if row.submitted_by_id == user.id:
        raise HTTPException(403, "Resolution must be reviewed by a different QA user")
    if payload.decision == "Return" and not payload.comments:
        raise HTTPException(400, "A reason is required when returning the correction")
    if payload.decision == "Resume":
        if not payload.verification_confirmed:
            raise HTTPException(400, "Fresh verification of this obstacle's latest correction is required")
        if row.readiness_required and not payload.readiness_confirmed:
            raise HTTPException(400, "Confirm fresh readiness review for the affected changed scope")
    previous = row.status
    row.status = "RESOLVED" if payload.decision == "Resume" else "OPEN"
    row.reviewed_by_id = user.id
    row.reviewed_at = models.now()
    row.revision += 1
    _refresh(db, obj, row.resume_stage)
    confirmation = "Fresh QA verification confirmed." + (" Affected scope readiness rechecked." if row.readiness_required else "") if payload.decision == "Resume" else ""
    _audit(db, obj, row, user, "Obstacle reviewed and resumed" if payload.decision == "Resume" else "Obstacle correction returned", previous, (confirmation + "\n" + (payload.comments or "")).strip())
    return _save(db, obj, user)


def notification_route(db, action, target):
    """Route a scoped handoff to its actual next owner, never the whole team."""
    if not isinstance(target, (models.SASTRequest, models.DASTRequest)) or not str(action.step_name or "").startswith("Security obstacle #"):
        return None
    try:
        obstacle_id = int(action.step_name.rsplit("#", 1)[1])
    except ValueError:
        return None
    row = next((row for row in target.obstacles if row.id == obstacle_id), None)
    if row is None:
        return None
    from .email_notifications import NotificationRoute, _workspace_role_user_ids, _role_user_ids
    if row.status == "OPEN":
        recipients = {_input_owner(target)} if row.kind == "REQUESTER" else {row.owner_id}
        label = "Requester / active delegate" if row.kind == "REQUESTER" else "Internal hold owner"
        message = "Resolve the recorded obstacle and submit it for fresh QA review."
    elif row.status == "SCOPE_APPROVAL_PENDING":
        roles = {Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM}
        recipients = (_workspace_role_user_ids(db, target.qa_workspace_id, roles) if target.qa_workspace_id
                      else _role_user_ids(db, roles, target.department))
        # Match endpoint authority, including maker/checker and unit scope.
        from .deps import has_department_unit_action_scope
        eligible = set()
        for uid in recipients:
            candidate = db.get(models.User, uid)
            if not candidate or uid in {target.requester_id, row.submitted_by_id} or not candidate.has_department(target.department):
                continue
            if not has_department_unit_action_scope(db, candidate, target.department, target.qa_request.department_unit_id if target.qa_request else None):
                continue
            try:
                _workflow()._require_distinct_department_head_approver(db, target, candidate)
            except HTTPException:
                continue
            eligible.add(uid)
        recipients = eligible
        label, message = "Department Head", "Review the changed scope before fresh QA verification."
    else:
        def eligible_reviewer(uid):
            from .workspace_service import workspace_context, selectable_workspace_ids, inherited_workspace_access_mode
            candidate = db.get(models.User, uid) if uid else None
            if not candidate or not candidate.is_active or (row.status == "QA_REVIEW_PENDING" and uid == row.submitted_by_id):
                return False
            workspace_id = target.qa_workspace_id
            if workspace_id and (workspace_id not in selectable_workspace_ids(db, candidate) or
                                 inherited_workspace_access_mode(db, candidate, workspace_id) == "PARENT_VIEWER"):
                return False
            # Notification eligibility follows the record's workspace, not
            # the workspace selected by the actor who triggered this audit.
            with workflow_context(candidate), workspace_context(workspace_id, [workspace_id] if workspace_id else []):
                if not _reviewer(target, candidate):
                    return False
                try:
                    _workflow()._require_visible(db, target, candidate)
                except HTTPException:
                    return False
            return True
        recipients = {target.security_analyst_id} if eligible_reviewer(target.security_analyst_id) else set()
        if not recipients:
            candidates = _workspace_role_user_ids(db, target.qa_workspace_id, set(LEAD_ROLES)) if target.qa_workspace_id else _role_user_ids(db, set(LEAD_ROLES), None)
            recipients = {uid for uid in candidates if eligible_reviewer(uid)}
        label = "Assigned Security Analyst / QA reviewer"
        message = "Review the latest obstacle correction before resuming." if row.status == "QA_REVIEW_PENDING" else "The obstacle passed fresh QA review. Continue the preserved scan workflow."
    recipients.discard(None)
    return NotificationRoute(recipients, label, True, message, frozenset(recipients))


def register_routes(router):
    def register(kind, cls, output):
        prefix = f"/api/{kind.lower()}-requests/{{req_id}}/obstacles"

        def create(req_id: int, payload: schemas.SecurityObstacleCreate, db: Session = Depends(get_db), user: models.User = Depends(get_workflow_user)):
            return create_obstacle(db, cls, req_id, payload, user)

        def submit(req_id: int, obstacle_id: int, payload: schemas.SecurityObstacleSubmit, db: Session = Depends(get_db), user: models.User = Depends(get_workflow_user)):
            return submit_obstacle(db, cls, req_id, obstacle_id, payload, user)

        def review(req_id: int, obstacle_id: int, payload: schemas.SecurityObstacleReview, db: Session = Depends(get_db), user: models.User = Depends(get_workflow_user)):
            return review_obstacle(db, cls, req_id, obstacle_id, payload, user)

        def approve(req_id: int, obstacle_id: int, payload: schemas.SecurityObstacleApproval, db: Session = Depends(get_db), user: models.User = Depends(get_workflow_user)):
            return approve_obstacle(db, cls, req_id, obstacle_id, payload, user)

        def permit(req_id: int, obstacle_id: int, payload: schemas.SecurityObstacleScopePermission, db: Session = Depends(get_db), user: models.User = Depends(get_workflow_user)):
            return set_scope_permission(db, cls, req_id, obstacle_id, payload, user)

        def route(req_id: int, obstacle_id: int, payload: schemas.SecurityObstacleRouting, db: Session = Depends(get_db), user: models.User = Depends(get_workflow_user)):
            return route_obstacle(db, cls, req_id, obstacle_id, payload, user)

        for suffix, endpoint in (("", create), ("/{obstacle_id}/submit", submit), ("/{obstacle_id}/review", review), ("/{obstacle_id}/scope-decision", approve), ("/{obstacle_id}/route", route)):
            endpoint.__name__ = f"{kind.lower()}_obstacle_{endpoint.__name__}"
            router.add_api_route(prefix + suffix, endpoint, methods=["POST"], response_model=output)
        if kind == "SAST":
            permit.__name__ = "sast_obstacle_scope_permission"
            router.add_api_route(prefix + "/{obstacle_id}/scope-permission", permit, methods=["POST"], response_model=output)
    register("SAST", models.SASTRequest, schemas.SASTOut)
    register("DAST", models.DASTRequest, schemas.DASTOut)
