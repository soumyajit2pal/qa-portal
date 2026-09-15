"""Request-scoped certificate evidence captured independently of live records."""
import json
from collections import Counter
from fastapi import HTTPException
from sqlalchemy import or_
from . import models

TERMINAL = {'Closed', 'Rejected', 'Duplicate', 'Not a Defect'}
EXECUTION_STATUSES = ['Pass', 'Fail', 'Blocked', 'NA', 'Retest Passed', 'Not Executed']
DEFECT_BUCKETS = ['Fix Pending', 'Retest Pending', 'Reopened / Retest Failed', 'Business Acceptance Pending', 'Release Pending', 'Production Verification Pending', 'Blocked', 'Deferred', 'Closed', 'Rejected', 'Duplicate', 'Not a Defect']


def defect_bucket(defect):
    if defect.status in TERMINAL:
        return defect.status
    if (defect.workflow_state or {}).get('blocked'):
        return 'Blocked'
    if defect.status == 'Deferred':
        return 'Deferred'
    if defect.status == 'Reopened':
        return 'Reopened / Retest Failed'
    if defect.status == 'Business Acceptance':
        return 'Business Acceptance Pending'
    if defect.status == 'Ready for Release':
        return 'Release Pending'
    if defect.status == 'Production Verification':
        return 'Production Verification Pending'
    if defect.status in {'Resolved', 'Retest', 'Ready for QA', 'QA Testing'}:
        return 'Retest Pending'
    return 'Fix Pending'


def aggregate(executions, defects):
    executions = {item.id: item for item in executions}.values()
    defects = list({item.id: item for item in defects}.values())
    counts = Counter(item.status for item in executions)
    total = sum(counts.values())
    applicable = total - counts['NA']
    passed = counts['Pass'] + counts['Retest Passed']
    buckets = Counter(defect_bucket(item) for item in defects)
    severity = []
    for level in ['Critical', 'High', 'Medium', 'Low']:
        rows = [item for item in defects if item.severity == level]
        closed = sum(item.status in TERMINAL for item in rows)
        severity.append({'severity': level, 'open': len(rows) - closed, 'closed': closed, 'total': len(rows)})
    return {'execution': {'total': total, 'counts': dict(counts), 'pass_pct': round(100 * passed / applicable, 2) if applicable else None},
            'defects': {'total': len(defects), 'counts': dict(buckets)}, 'severity': severity,
            'open_critical_high': sum(row['open'] for row in severity if row['severity'] in {'Critical', 'High'})}


def assigned_testers(db, source):
    ids = sorted({int(value.strip()) for value in (source.assigned_tester_ids or '').split(',')
                  if value.strip().isdigit() and int(value.strip()) > 0})
    users = {user.id: user for user in db.query(models.User).filter(models.User.id.in_(ids)).all()} if ids else {}
    return [{'id': ident, 'name': (users[ident].full_name or users[ident].username) if ident in users
             else f'User #{ident} (unavailable)'} for ident in ids]


def assigned_testers_label(snapshot):
    if not snapshot or 'assigned_testers' not in snapshot:
        return 'Not captured — refresh and reapproval required'
    return ', '.join(item['name'] for item in snapshot['assigned_testers']) or 'Not assigned'


def capture(db, obj):
    source = db.query(models.FunctionalRequest).filter_by(request_id=obj.testing_request_id).first()
    if not source or not source.qa_request or source.qa_request.qa_workspace_id != obj.qa_workspace_id:
        raise HTTPException(400, 'The certificate must link to a Functional Request in its workspace')
    cycles = db.query(models.TestCycle.id).join(models.TestCycleChildRequestLink).filter(
        models.TestCycleChildRequestLink.child_type == 'Functional', models.TestCycleChildRequestLink.child_id == source.id)
    # A certificate is scoped to the declared tested environment/build.
    if obj.environment_tested:
        cycles = cycles.filter(models.TestCycle.environment == obj.environment_tested)
    if obj.build_number:
        cycles = cycles.filter(models.TestCycle.build == obj.build_number)
    execution_ids = db.query(models.TestExecution.id).filter(models.TestExecution.cycle_id.in_(cycles))
    executions = db.query(models.TestExecution).filter(models.TestExecution.id.in_(execution_ids)).order_by(models.TestExecution.id).all()
    defects = db.query(models.Defect).filter(
        or_(models.Defect.qa_workspace_id == obj.qa_workspace_id,
            models.Defect.qa_request.has(models.QARequest.qa_workspace_id == obj.qa_workspace_id)),
        or_(models.Defect.qa_request_id == source.qa_request_id,
            models.Defect.execution_id.in_(execution_ids),
            models.Defect.execution_links.any(models.DefectExecutionLink.execution_id.in_(execution_ids)),
            models.Defect.cycle_id.in_(cycles))).order_by(models.Defect.id).all()
    result = aggregate(executions, defects)
    result['assigned_testers'] = assigned_testers(db, source)
    result['certificate_fields'] = {key: str(getattr(obj, key, None) or '') for key in ('certificate_type', 'testing_type', 'testing_request_id', 'application_name', 'application_owner', 'department', 'release_version', 'build_number', 'environment_tested', 'target_promotion_environment', 'exit_criteria_notes', 'open_defect_summary', 'residual_risk_notes', 'known_limitations', 'business_acceptance_status', 'security_testing_status', 'deployment_recommendation', 'conditional_observations')}
    result['execution_results'] = sorted([{'id': item.id, 'status': item.status, 'pinned_version_id': item.pinned_version_id, 'run_version': item.run_version, 'executed_at': str(item.executed_at)} for item in executions], key=lambda item: item['id'])
    result['defect_results'] = sorted([{'id': item.id, 'status': item.status, 'severity': item.severity, 'revision': item.workflow_revision, 'updated_at': str(item.updated_at)} for item in defects], key=lambda item: item['id'])
    result['conditional_observations'] = (obj.conditional_observations or '').strip()
    result['observations'] = [{'defect_key': item.defect_key, 'functionality': item.module_feature,
        'observation': item.title, 'severity': item.severity, 'status': item.status,
        'owner': item.assignee_name or 'Not assigned',
        'target_date': str(item.expected_resolution_date or 'Not recorded')}
        for item in defects if item.status not in TERMINAL]
    result['security'] = []
    for label, model in [('SAST', models.SASTRequest), ('DAST', models.DASTRequest)]:
        for item in db.query(model).filter_by(qa_request_id=source.qa_request_id).order_by(model.id).all():
            result['security'].append({'type': label, 'request_id': item.request_id,
                'status': item.status, 'findings': len(item.findings), 'risk_level': item.risk_category or 'Not recorded'})
    result.update(captured_at=models.now().isoformat(), application_name=source.qa_request.application_name,
                  change_request_ids=obj.change_request_ids or ' / '.join(filter(None, [source.qa_request.cr_number, source.qa_request.epic_number])),
                  change_description=source.qa_request.change_description or '',
                  testing_request_id=obj.testing_request_id, qa_request_id=source.qa_request_id,
                  environment=obj.environment_tested, build=obj.build_number,
                  execution_ids=[item.id for item in executions], defect_ids=[item.id for item in defects],
                  cycle_ids=[row[0] for row in cycles.all()],
                  population_note='Latest result per execution slot in linked Functional Request cycles, filtered by certificate environment and build when specified. Defects include direct QA Request links and primary/additional links to these cycles; each defect is counted once. Deferred remains open. Pass % = (Pass + Retest Passed) / (Total − NA). No matching records means no evidence, not a passing result.')
    return result


def refresh(db, obj):
    previous = json.loads(obj.certificate_data_json or '{}')
    snapshot = capture(db, obj)
    history = previous.get('history', [])
    if previous.get('current'):
        history.append({**previous['current'], 'archived_status': obj.status, 'reviewed_by_id': obj.reviewed_by_id, 'approved_by_id': obj.approved_by_id})
    snapshot['revision'] = len(history) + 1
    obj.certificate_data_json = json.dumps({'current': snapshot, 'history': history})
    return snapshot


def validate(obj, db=None):
    snapshot = obj.certificate_summary
    if not snapshot:
        raise HTTPException(400, 'Refresh certificate summaries before requesting approval')
    if db is not None:
        live = capture(db, obj)
        # Never silently replace reviewed evidence. Changes require an explicit refresh.
        for field in ('assigned_testers', 'execution', 'defects', 'severity', 'execution_ids', 'defect_ids', 'observations', 'security', 'execution_results', 'defect_results', 'change_request_ids', 'change_description', 'conditional_observations'):
            if live.get(field) != snapshot.get(field):
                raise HTTPException(409, 'Linked evidence changed since capture. Refresh the certificate and obtain full reapproval.')
    if obj.certificate_type == 'Full Clearance':
        if not snapshot['execution']['total']:
            raise HTTPException(400, 'Full Clearance requires linked test execution evidence for the selected environment/build')
        if snapshot['open_critical_high']:
            raise HTTPException(400, 'Full Clearance cannot be issued while linked Critical or High defects remain open, including Deferred defects')


def markdown_tables(snapshot):
    def table(headers, rows):
        def cell(value): return str(value).replace('|', '\\|').replace('\n', ' ')
        return '\n'.join(['| ' + ' | '.join(map(cell, headers)) + ' |', '| ' + ' | '.join(['---'] * len(headers)) + ' |'] + ['| ' + ' | '.join(map(cell, row)) + ' |' for row in rows])
    e = snapshot['execution']
    identity = table(['CR/EPIC Number', 'Change Description'], [[snapshot.get('change_request_ids', 'Not captured — refresh and reapproval required') or 'Not recorded', snapshot.get('change_description', 'Not captured — refresh and reapproval required') or 'Not recorded']]) + '\n\n'
    return [
        ('Section B – QA Test Case Execution Summary', identity + table(['Total', *EXECUTION_STATUSES, 'Pass %'], [[e['total'], *[e['counts'].get(s, 0) for s in EXECUTION_STATUSES], e['pass_pct'] if e['pass_pct'] is not None else 'NA']])),
        ('Section C – QA Defect Status Summary', identity + table(['Status', 'Count'], [(s, snapshot['defects']['counts'].get(s, 0)) for s in DEFECT_BUCKETS] + [('Total', snapshot['defects']['total'])])),
        ('Defect Severity-wise Breakdown', table(['Severity', 'Open', 'Closed', 'Total'], [[r['severity'], r['open'], r['closed'], r['total']] for r in snapshot['severity']]))]
