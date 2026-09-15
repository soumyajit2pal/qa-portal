"""Modern workflow mutation handler. Uses existing defect scope and actors."""
import json
from fastapi import HTTPException
from .. import models
from ..constants import Role, ENVIRONMENTS
from ..defect_workflow import state, policy, transitions, environment_for, production_required


def apply_action(db, obj, payload, user):
    from . import defects as d
    # Scope is checked by the caller; lock only the base table (Oracle disallows
    # FOR UPDATE on the outer-joined visibility query).
    db.query(models.Defect).filter_by(id=obj.id).with_for_update().populate_existing().one()
    if not obj.workflow_json:
        raise HTTPException(400, 'This defect uses the legacy workflow')
    if payload.revision != obj.workflow_revision:
        raise HTTPException(409, 'Defect changed. Refresh and review before retrying.')
    s = state(obj)
    p = policy(obj.workflow_json)
    manager = d._is_manager(db, obj, user)
    assignee = d._is_assignee(obj, user)
    qa = obj.retest_tester_id == user.id
    business = s.get('business_owner_id') == user.id
    release = s.get('release_owner_id') == user.id
    previous = obj.status
    event = {'at': models.now().isoformat(), 'user_id': user.id, 'user_name': user.full_name,
             'iteration': s.get('iteration', 0), 'from': previous}

    if payload.evidence_document_ids:
        available = {doc.id: doc for doc in d.doc_store.list_documents(db, d._DOC_MODULE, obj.id)}
        evidence_ids = list(dict.fromkeys(payload.evidence_document_ids))
        if any(doc_id not in available for doc_id in evidence_ids):
            raise HTTPException(400, 'Evidence must be attached to this defect')
        event['evidence_documents'] = [{'id': doc_id, 'file_name': available[doc_id].file_name} for doc_id in evidence_ids]
        if not (payload.reference or '').strip():
            payload = payload.model_copy(update={'reference': 'Attached evidence: ' + ', '.join(available[doc_id].file_name for doc_id in evidence_ids)})

    def required(value, name):
        if value is None or not str(value).strip():
            raise HTTPException(400, f'{name} is required')
        return str(value).strip()

    def allowed(condition):
        if not condition:
            raise HTTPException(403, 'You are not the authorized owner for this workflow action')

    def owner(value, name):
        candidate = db.get(models.User, value) if value else None
        from ..defect_assignment import assignment_error
        field = {'resolver': 'assignee_id', 'QA tester': 'retest_tester_id',
                 'business acceptance owner': 'business_owner_id', 'release owner': 'release_owner_id'}[name]
        error = assignment_error(db, obj, candidate, field, payload.assigned_team)
        if error:
            raise HTTPException(400, f'{name}: {error}')
        return candidate

    def verification(result):
        env = environment_for(obj, previous)
        build = required(payload.build, 'Tested build')
        if build != s.get('deployed_build'):
            raise HTTPException(400, 'Tested build must match the build recorded for this stage')
        evidence = required(payload.reference, 'Evidence reference')
        notes = required(payload.remarks, 'Observed result and verification notes')
        if result == 'Passed' and previous == 'QA Testing' and not payload.regression_confirmed:
            raise HTTPException(400, 'Confirm applicable regression testing before passing QA')
        event.update(kind='verification', stage=previous, environment=env, build=build,
                     result=result, reference=evidence, remarks=notes)
        obj.tested_build_version = build
        obj.retest_result = result
        obj.retest_actual_result = notes
        obj.retest_remarks = evidence
        obj.retest_at = models.now()

    if payload.action == 'occurrence':
        allowed(manager or assignee or qa or business or release or obj.reporter_id == user.id)
        if previous in ('Closed', 'Duplicate', 'Not a Defect', 'Rejected'):
            raise HTTPException(400, 'Reopen the defect before recording another occurrence')
        if payload.environment not in ENVIRONMENTS:
            raise HTTPException(400, 'Select a valid environment')
        event.update(kind='occurrence', environment=payload.environment,
                     build=required(payload.build, 'Affected build'),
                     remarks=required(payload.remarks, 'Reproduction notes'),
                     reference=required(payload.reference, 'Evidence reference'))
        s.setdefault('occurrences', []).append(dict(event))
        if payload.environment == 'Production':
            s['production_impact'] = 'Affected'
    elif payload.action == 'block':
        allowed(manager or assignee or qa or business or release)
        s['blocked'] = {'reason': required(payload.remarks, 'Blocker reason'), 'owner_id': user.id,
                        'review_date': required(payload.review_date, 'Review date')}
        event.update(kind='blocked', **s['blocked'])
    elif payload.action == 'unblock':
        allowed(manager or (s.get('blocked') or {}).get('owner_id') == user.id)
        event.update(kind='unblocked', remarks=required(payload.remarks, 'Unblocking reason'))
        s.pop('blocked', None)
    elif payload.action == 'transition':
        target = payload.status
        if target not in transitions(obj):
            raise HTTPException(400, f'Invalid transition from {previous} to {target}')
        if s.get('blocked'):
            raise HTTPException(400, 'Clear the blocker before changing stage')
        event.update(kind='transition', to=target, remarks=payload.remarks)
        if target == 'Triaged':
            allowed(d._can_assign(db, obj, user))
            impact = payload.production_impact
            if impact not in ('Affected', 'Unaffected', 'Unknown'):
                raise HTTPException(400, 'Assess production impact')
            s['production_impact'] = 'Affected' if production_required(obj) and obj.environment == 'Production' else impact
            person = owner(payload.assignee_id, 'resolver')
            dept = required(payload.assigned_team, 'Assigned department')
            if not person.has_department(dept):
                raise HTTPException(400, 'Resolver must belong to the selected department')
            obj.assignee_id = person.id
            obj.assigned_team = dept
            obj.assigned_by_id = user.id
            obj.assigned_at = models.now()
            obj.assignment_remarks = required(payload.remarks, 'Triage assessment')
            event.update(assignee_id=person.id, assigned_team=dept)
            s['release_owner_id'] = owner(payload.release_owner_id, 'release owner').id if payload.release_owner_id else None
            if p['business_acceptance']:
                s['business_owner_id'] = owner(payload.business_owner_id, 'business acceptance owner').id
        elif target == 'In Progress':
            allowed(manager or assignee)
        elif target == 'Ready for QA':
            allowed(manager or assignee)
            obj.root_cause = required(payload.root_cause, 'Root cause')
            obj.fix_details = required(payload.fix_details, 'Fix details')
            event.update(root_cause=obj.root_cause, fix_details=obj.fix_details)
            obj.fixed_build_version = required(payload.build, 'Deployed QA build')
            obj.resolution_summary = obj.fix_details
            obj.resolution_type = 'Fixed'
            obj.resolved_at = models.now()
            obj.retest_tester_id = owner(payload.retest_tester_id, 'QA tester').id
            s.pop('verification_invalidated', None)
            s['iteration'] = s.get('iteration', 0) + 1
            s['deployed_build'] = obj.fixed_build_version
            s['qa_build'] = obj.fixed_build_version
            event.update(iteration=s['iteration'], kind='deployment', environment=p['qa_environment'],
                         build=obj.fixed_build_version, reference=required(payload.reference, 'Deployment/change reference'))
        elif target == 'QA Testing':
            allowed(manager or qa)
        elif target == 'Reopened':
            allowed(manager or (previous == 'Closed' and obj.reporter_id == user.id)
                    or (previous in ('QA Testing', 'Ready for QA') and qa)
                    or (previous == 'Business Acceptance' and business)
                    or (previous in ('Ready for Release', 'Production Verification') and release)
                    or (previous in ('Rejected', 'Not a Defect') and (assignee or obj.reporter_id == user.id)))
            obj.reopen_reason = required(payload.remarks, 'Reopening reason')
            required(payload.reference, 'Supporting evidence reference')
            if environment_for(obj, previous):
                verification('Failed')
            s['verification_invalidated'] = True
            obj.reopen_count += 1
            obj.closed_at = None
            obj.resolution_type = None
        elif target == 'Accept Risk':
            allowed(user.has_role(Role.ADMIN, Role.APPLICATION_OWNER))
            obj.resolution_type = 'Accepted Risk'
            obj.closure_remarks = required(payload.remarks, 'Risk acceptance rationale')
            required(payload.reference, 'Risk decision reference')
            obj.closed_at = models.now()
            event.update(to='Closed', resolution='Accepted Risk', reference=payload.reference)
            target = 'Closed'
        elif target in ('Deferred', 'Rejected', 'Not a Defect', 'Duplicate'):
            if d._qa_disposition_blocked_for_requester_assignment(obj, user, target):
                raise HTTPException(403, 'This disposition is controlled by the requester side')
            allowed(d._can_defer(db, obj, user) if target == 'Deferred' else
                    (manager or assignee or obj.reporter_id == user.id or d._is_assignee_department_head(db, obj, user)))
            if target == 'Not a Defect':
                allowed((obj.assignee_is_requester and (assignee or d._is_assignee_department_head(db, obj, user) or user.has_role(Role.ADMIN)))
                        or (not obj.assignee_is_requester and (manager or obj.reporter_id == user.id)))
            reason = required(payload.remarks, 'Decision reason')
            if target == 'Deferred':
                obj.deferral_reason = reason
                obj.deferral_approved_by = str(user.id)
                obj.target_release = required(payload.target_release, 'Target release')
                if not payload.review_date or payload.review_date < models.today_ist():
                    raise HTTPException(400, 'Select a current or future review date')
                obj.expected_resolution_date = payload.review_date
            elif target == 'Duplicate':
                original = d._get_visible(payload.duplicate_defect_id, db, user)
                if original.id == obj.id or original.status == 'Duplicate':
                    raise HTTPException(400, 'Select a different canonical defect')
                obj.duplicate_of_id = original.id
            elif target == 'Not a Defect':
                obj.not_a_defect_reason = reason
            else:
                obj.rejection_reason = reason
        else:
            # Leaving verification records a passed result before release/closure.
            allowed(manager or (previous == 'QA Testing' and qa)
                    or (previous == 'Business Acceptance' and business)
                    or (previous in ('Ready for Release', 'Production Verification') and release))
            if environment_for(obj, previous):
                verification('Passed')
            if target in ('Closed', 'Ready for Release') and s.get('production_impact') == 'Unknown':
                raise HTTPException(400, 'Resolve unknown production impact before completing verification')
            if target == 'Business Acceptance':
                s['deployed_build'] = required(payload.build, 'Business verification build')
            if target == 'Ready for Release':
                obj.target_release = required(payload.target_release, 'Target release')
                s['release_owner_id'] = owner(payload.release_owner_id or s.get('release_owner_id'), 'release owner').id
            if target == 'Production Verification':
                s['deployed_build'] = required(payload.build, 'Deployed production build')
                event.update(kind='deployment', environment='Production', build=s['deployed_build'],
                             reference=required(payload.reference, 'Successful deployment reference'))
            if target == 'Closed':
                obj.closed_at = models.now()
                obj.resolution_type = 'Fixed'
                obj.closure_remarks = required(payload.remarks, 'Closure summary')
        obj.status = target
    elif payload.action == 'assess':
        allowed(d._can_assign(db, obj, user))
        if previous in ('Closed', 'Duplicate', 'Rejected', 'Not a Defect'):
            raise HTTPException(400, 'Reopen this defect before changing its assessment')
        if payload.production_impact not in ('Affected', 'Unaffected', 'Unknown'):
            raise HTTPException(400, 'Select production impact')
        if previous in ('Ready for Release', 'Production Verification') and payload.production_impact != 'Affected':
            raise HTTPException(400, 'Production delivery is already underway; retain production verification')
        if payload.production_impact != 'Affected' and (obj.environment == 'Production' or any(
                e['environment'] == 'Production' for e in s.get('occurrences', []))):
            raise HTTPException(400, 'A recorded production occurrence requires production verification')
        s['production_impact'] = payload.production_impact
        event.update(kind='assessment', production_impact=payload.production_impact,
                     remarks=required(payload.remarks, 'Assessment evidence and rationale'))
    else:
        raise HTTPException(400, 'Unknown workflow action')
    s.setdefault('history', []).append(event)
    obj.workflow_state_json = json.dumps(s)
    obj.workflow_revision += 1
    db.query(models.TestRunDefect).filter(models.TestRunDefect.defect_key == obj.defect_key).update(
        {models.TestRunDefect.defect_status: obj.status}, synchronize_session=False)
    comments = '\n'.join(str(x) for x in [event.get('remarks'), event.get('environment'),
                           event.get('build'), event.get('result'), event.get('reference')] if x)
    d._audit(db, obj, user, obj.status if payload.action == 'transition' else event['kind'],
             comments or event['kind'], previous, obj.status)
    db.commit()
    db.refresh(obj)
    return obj
