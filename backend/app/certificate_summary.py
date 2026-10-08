"""Request-scoped certificate evidence captured independently of live records."""
import datetime
import json
import re
from collections import Counter
from datetime import date
from html import unescape
from fastapi import HTTPException
from sqlalchemy import or_
from . import models
from .constants import CERTIFICATE_TYPES, ENVIRONMENT_PIPELINE_ORDER, QAStatus, SAST_DAST_CLEARANCE_RESOLVED_STATUSES

TERMINAL = {'Closed', 'Rejected', 'Duplicate', 'Not a Defect', 'Change Request Raised'}
EXECUTION_STATUSES = ['Pass', 'Fail', 'Blocked', 'NA', 'Retest Passed', 'Not Executed']
EXECUTION_POPULATION_BASIS = 'unique_testcase_latest'
FULL_CLEARANCE_EXECUTION_STATUSES = {'Pass', 'Retest Passed', 'NA'}
CLEARANCE_TYPES = {'Full Clearance', 'Conditional Clearance'}
CLEARANCE_SOURCE_STATUSES = {QAStatus.QA_COMPLETED, QAStatus.QA_SIGNOFF_PENDING}
CLEARANCE_ENVIRONMENTS = {value.casefold() for value in ENVIRONMENT_PIPELINE_ORDER[:-1]}
CONDITIONAL_FIELDS = ('conditional_mitigation', 'conditional_owner', 'conditional_target_date')
DEFECT_BUCKETS = ['Fix Pending', 'Not a Defect Review Pending', 'Retest Pending', 'Reopened / Retest Failed', 'Business Acceptance Pending', 'Release Pending', 'Production Verification Pending', 'Blocked', 'Deferred', 'Closed', 'Rejected', 'Duplicate', 'Not a Defect', 'Change Request Raised']


def defect_bucket(defect):
    if defect.status in TERMINAL:
        return defect.status
    if (defect.workflow_state or {}).get('blocked'):
        return 'Blocked'
    if defect.status == 'Deferred':
        return 'Deferred'
    if defect.status == 'Reopened':
        return 'Reopened / Retest Failed'
    if defect.status == 'Not a Defect Review':
        return 'Not a Defect Review Pending'
    if defect.status == 'Business Acceptance':
        return 'Business Acceptance Pending'
    if defect.status == 'Ready for Release':
        return 'Release Pending'
    if defect.status == 'Production Verification':
        return 'Production Verification Pending'
    if defect.status in {'Resolved', 'Retest', 'Ready for QA', 'QA Testing'}:
        return 'Retest Pending'
    return 'Fix Pending'


def latest_testcase_executions(executions):
    """Return one deterministic latest/effective slot per logical testcase.

    A Functional Request may legitimately have several independent current
    leaf cycles for the same environment. The same testcase can therefore
    appear in more than one eligible cycle, but a certificate's "Test cases"
    figure is a logical-testcase population, not a count of cycle slots.

    An executed slot's latest result becomes effective at ``executed_at``.
    An untouched slot becomes effective when it was added (``created_at``),
    which is important for conditional evidence: a newly-added Not Executed
    testcase must not be hidden by an older Pass from another leaf cycle.
    The immutable execution id is the final tie-breaker. ``as_aware`` keeps
    Oracle's timezone-naive DateTime values comparable with newly-created,
    timezone-aware ORM values.

    Lightweight aggregate callers used by reports/tests may not carry a
    test_case_id or timestamps. They retain the historical id-based behavior.
    """
    minimum = datetime.datetime.min.replace(tzinfo=datetime.UTC)

    def recency(item):
        effective_at = getattr(item, 'executed_at', None) or getattr(item, 'created_at', None)
        normalized = (
            models.as_aware(effective_at).astimezone(datetime.UTC)
            if effective_at is not None else minimum
        )
        return normalized, int(getattr(item, 'id', None) or 0)

    latest = {}
    for item in executions:
        test_case_id = getattr(item, 'test_case_id', None)
        execution_id = getattr(item, 'id', None)
        key = ('testcase', test_case_id) if test_case_id is not None else (
            'execution', execution_id if execution_id is not None else id(item)
        )
        current = latest.get(key)
        if current is None or recency(item) > recency(current):
            latest[key] = item
    return sorted(latest.values(), key=lambda item: int(getattr(item, 'id', None) or 0))


def aggregate(executions, defects):
    executions = latest_testcase_executions(executions)
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
    return {'execution_population_basis': EXECUTION_POPULATION_BASIS,
            'execution': {'total': total, 'counts': dict(counts), 'pass_pct': round(100 * passed / applicable, 2) if applicable else None},
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


def require_linked_security_resolved(db, source):
    """Wait for each selected security sibling to finish or be terminally rejected."""
    if not source.qa_request_id or not source.qa_request:
        return
    selected = {value.strip().upper() for value in (source.qa_request.request_types or '').split(',')}
    pending = []
    for label, model in [('SAST', models.SASTRequest), ('DAST', models.DASTRequest)]:
        siblings = db.query(model).filter_by(qa_request_id=source.qa_request_id).order_by(model.id).all()
        if label in selected and not siblings:
            pending.append(f'{label} child request missing')
        for item in siblings:
            if item.status not in SAST_DAST_CLEARANCE_RESOLVED_STATUSES:
                pending.append(f'{label} {item.request_id or "(no ID)"} ({item.status or "no status"})')
            elif item.status == 'CLOSED':
                from .security_scan_state import all_repositories_clear, all_targets_clear
                scans = db.query(models.SecurityScanResult).filter_by(request_type=label, request_id=item.id).order_by(
                    models.SecurityScanResult.imported_at.desc(), models.SecurityScanResult.id.desc()).all()
                is_clear = all_repositories_clear if label == 'SAST' else all_targets_clear
                if not is_clear(item, scans):
                    scope = 'repository' if label == 'SAST' else 'target'
                    pending.append(f'{label} {item.request_id or "(no ID)"} ({scope} coverage is incomplete, stale or awaiting validation)')
    if pending:
        raise HTTPException(409,
            'QA Clearance cannot be raised until every linked SAST/DAST request is '
            'Closed or terminally rejected by the Department Head: '
            + ', '.join(pending))


def require_linked_security_closed(db, source):
    """Backward-compatible alias for the resolved security prerequisite."""
    return require_linked_security_resolved(db, source)


def security_scan_counts(results, kind=None):
    """Oldest-first snapshots: initial Auditor totals and latest suppressions per target."""
    from .security_scan_state import current_scan_results, initial_repository_results
    if not results:
        return {'initial_findings': None, 'current_findings': None, 'suppression_count': None}
    initial = initial_repository_results(results)
    def auditor_total(row):
        # Filter sets overlap. Use only the Auditor view, never their sum.
        auditor = next((entry for entry in row.filters
                        if 'security auditor view' in str(entry.get('title', '')).strip().casefold()), None)
        return int(auditor.get('total_count') or 0) if auditor else int(row.total_count or 0)
    current = current_scan_results(list(reversed(results)))
    return {
        'initial_findings': sum(auditor_total(row) for row in initial),
        'current_findings': sum(auditor_total(row) for row in current),
        'suppression_count': sum(int(row.suppressed_total_count or 0)
                                 for row in current),
    }


def security_assessment_rows(snapshot):
    from .constants import SAST_DAST_STATUS_LABELS
    def count(row, key):
        value = row.get(key)
        return str(value) if value is not None else 'Not captured'
    return [[row['type'], row['request_id'], SAST_DAST_STATUS_LABELS.get(row['status'], row['status']),
             count(row, 'initial_findings'), count(row, 'current_findings'), count(row, 'suppression_count'),
             ', '.join(row['suppression_request_ids']) or 'None' if row.get('suppression_request_ids') is not None else 'Not captured']
            for row in snapshot.get('security', [])]


def security_assessment_table(snapshot):
    headers = ['Type', 'Request ID', 'Current status', 'Initial total findings', 'Current findings', 'Suppression count', 'Suppression request ID(s)']
    def cells(row):
        return '| ' + ' | '.join(str(value).replace('|', r'\|').replace('\n', ' ') for value in row) + ' |'
    rows = security_assessment_rows(snapshot)
    if not rows:
        return 'No linked security assessment recorded; this is not a Pass result.'
    table = '\n'.join([cells(headers), cells(['---'] * len(headers)), *[cells(row) for row in rows]])
    note = 'Status and counts are frozen at evidence capture. Findings use the Security Auditor View across all targets; suppression request IDs list all linked requests.'
    coverage = [f"{row['request_id']}: {row['repository_coverage']['clear']}/{row['repository_coverage']['total']} repositories clear"
                for row in snapshot.get('security', []) if row.get('repository_coverage')]
    if coverage:
        note += ' Repository coverage: ' + '; '.join(coverage) + '.'
    target_coverage = [f"{row['request_id']}: {row['target_coverage']['clear']}/{row['target_coverage']['total']} targets clear"
                       for row in snapshot.get('security', []) if row.get('target_coverage')]
    if target_coverage:
        note += ' Target coverage: ' + '; '.join(target_coverage) + '.'
    if any('Not captured' in row for row in rows):
        note += ' Missing values require evidence refresh and full reapproval.'
    return table + '\n\n' + note


def capture(db, obj):
    source = db.query(models.FunctionalRequest).filter_by(request_id=obj.testing_request_id).first()
    if not source or not source.qa_request or source.qa_request.qa_workspace_id != obj.qa_workspace_id:
        raise HTTPException(400, 'The certificate must link to a Functional Request in its workspace')
    require_linked_security_resolved(db, source)
    cycles_query = db.query(models.TestCycle).join(models.TestCycleChildRequestLink).filter(
        models.TestCycleChildRequestLink.child_type == 'Functional', models.TestCycleChildRequestLink.child_id == source.id)
    # Determine lineage leaves across every linked environment first. If a
    # successor was (incorrectly, or historically) moved to a different
    # environment, its predecessor must not reappear as current evidence in
    # the predecessor's environment merely because the successor was filtered
    # out. Build values remain captured as audit evidence but do not partition
    # eligibility.
    environment_tested = (obj.environment_tested or '').strip().lower()
    all_cycles = cycles_query.order_by(models.TestCycle.id).all()
    # A re-execution cycle replaces its predecessor for future execution
    # totals. Keep every historical cycle in the defect scope, though: a
    # defect raised in an earlier round remains material risk until its own
    # workflow resolves, even after execution moves to a successor cycle.
    superseded_cycle_ids = {
        cycle.reexecution_of_cycle_id
        for cycle in all_cycles
        if cycle.reexecution_of_cycle_id is not None
    }
    lineage_leaves = [
        cycle for cycle in all_cycles if cycle.id not in superseded_cycle_ids
    ]
    cycles = [
        cycle for cycle in lineage_leaves
        if not environment_tested
        or (cycle.environment or '').strip().lower() == environment_tested
    ]
    cycle_ids = [cycle.id for cycle in cycles]
    cycles_by_id = {cycle.id: cycle for cycle in all_cycles}
    defect_scope_cycle_ids = set()
    for leaf in cycles:
        cursor = leaf
        while cursor is not None and cursor.id not in defect_scope_cycle_ids:
            defect_scope_cycle_ids.add(cursor.id)
            cursor = cycles_by_id.get(cursor.reexecution_of_cycle_id)
    all_cycle_ids = [
        cycle.id for cycle in all_cycles if cycle.id in defect_scope_cycle_ids
    ]
    execution_ids = db.query(models.TestExecution.id).filter(models.TestExecution.cycle_id.in_(cycle_ids))
    all_execution_ids = db.query(models.TestExecution.id).filter(
        models.TestExecution.cycle_id.in_(all_cycle_ids)
    )
    executions = db.query(models.TestExecution).filter(models.TestExecution.id.in_(execution_ids)).order_by(models.TestExecution.id).all()
    defects = db.query(models.Defect).filter(
        or_(models.Defect.qa_workspace_id == obj.qa_workspace_id,
            models.Defect.qa_request.has(models.QARequest.qa_workspace_id == obj.qa_workspace_id)),
        or_(models.Defect.qa_request_id == source.qa_request_id,
            models.Defect.execution_id.in_(all_execution_ids),
            models.Defect.execution_links.any(models.DefectExecutionLink.execution_id.in_(all_execution_ids)),
            models.Defect.cycle_id.in_(all_cycle_ids))).order_by(models.Defect.id).all()
    result = aggregate(executions, defects)
    result['testing_scope'] = obj.live_testing_scope
    result['assigned_testers'] = assigned_testers(db, source)
    result['certificate_fields'] = {key: str(getattr(obj, key, None) or '') for key in ('certificate_type', 'testing_type', 'testing_request_id', 'application_name', 'application_owner', 'department', 'release_version', 'build_number', 'environment_tested', 'target_promotion_environment', 'exit_criteria_notes', 'open_defect_summary', 'residual_risk_notes', 'known_limitations', 'business_acceptance_status', 'security_testing_status', 'conditional_observations', *CONDITIONAL_FIELDS)}
    result['execution_results'] = sorted([{'id': item.id, 'status': item.status, 'pinned_version_id': item.pinned_version_id, 'run_version': item.run_version, 'executed_at': str(item.executed_at)} for item in executions], key=lambda item: item['id'])
    result['cycle_results'] = [
        {'id': cycle.id, 'status': cycle.status, 'environment': cycle.environment}
        for cycle in cycles
    ]
    result['source_status'] = source.status
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
            scans = db.query(models.SecurityScanResult).filter_by(request_type=label, request_id=item.id).order_by(
                models.SecurityScanResult.imported_at.asc(), models.SecurityScanResult.id.asc()).all()
            suppression_column = models.SuppressionRequest.sast_request_id if label == 'SAST' else models.SuppressionRequest.dast_request_id
            suppression_ids = [row[0] for row in db.query(models.SuppressionRequest.suppression_id).filter(
                suppression_column == item.id).order_by(models.SuppressionRequest.id).all()]
            result['security'].append({'type': label, 'request_id': item.request_id,
                'status': item.status, 'findings': len(item.findings), 'risk_level': item.risk_category or 'Not recorded',
                'suppression_request_ids': suppression_ids, **security_scan_counts(scans, label)})
            if label == 'SAST':
                from .security_scan_state import repository_states
                states = repository_states(item, list(reversed(scans)))
                # Freeze coverage and code identity beside the scan counts.
                # Historic certificate reads never recalculate this evidence.
                result['security'][-1]['repositories'] = [
                    {key: row[key] for key in ('target_id', 'label', 'state', 'git_branch', 'commit_id', 'latest_scan_id', 'open_findings')}
                    for row in states
                ]
                result['security'][-1]['repository_coverage'] = {
                    'total': len(states), 'clear': sum(row['state'] == 'CLEAR' for row in states),
                    'all_clear': bool(states) and all(row['state'] == 'CLEAR' for row in states),
                }
            else:
                from .security_scan_state import target_states
                states = target_states(item, list(reversed(scans)))
                result['security'][-1]['targets'] = [
                    {key: row[key] for key in ('target_id', 'label', 'state', 'environment', 'commit_id', 'latest_scan_id', 'open_findings')}
                    for row in states
                ]
                result['security'][-1]['target_coverage'] = {
                    'total': len(states), 'clear': sum(row['state'] == 'CLEAR' for row in states),
                    'all_clear': bool(states) and all(row['state'] == 'CLEAR' for row in states),
                }
    result.update(captured_at=models.now().isoformat(), application_name=source.qa_request.application_name,
                  change_request_ids=obj.change_request_ids or ' / '.join(filter(None, [source.qa_request.cr_number, source.qa_request.epic_number])),
                  change_description=source.qa_request.change_description or '',
                  change_type=source.qa_request.change_type,
                  business_defect_number=source.qa_request.business_defect_number if source.qa_request.change_type == 'Bug Fix' else None,
                  previous_request_id=source.qa_request.bug_fix_source_request_id if source.qa_request.change_type in {'Bug Fix', 'Enhancement'} else None,
                  testing_request_id=obj.testing_request_id, qa_request_id=source.qa_request_id,
                  environment=obj.environment_tested, build=obj.build_number,
                  execution_ids=[item.id for item in executions], defect_ids=[item.id for item in defects],
                  cycle_ids=cycle_ids, defect_scope_cycle_ids=all_cycle_ids,
                  population_note='Latest effective result per unique testcase across the leaf/latest linked Functional Request cycles of each re-execution lineage. When a testcase appears in more than one eligible leaf cycle, executed_at (or the slot created_at for Not Executed) determines the latest state, with execution ID as a deterministic tie-breaker. All eligible execution slots remain listed in the frozen audit trace even when duplicate testcase memberships are collapsed in the summary. Lineage leaves are determined before filtering by certificate environment, so a successor in another environment cannot make its predecessor current evidence again. Superseded execution rounds remain immutable history and are excluded from execution totals. Build values are retained as evidence and do not filter eligibility. Defects include direct QA Request links and primary/additional links across every historical ancestor of the selected environment-matching leaves; each defect is counted once. Deferred remains open. Pass % = (Pass + Retest Passed) / (Total − NA). No matching records means no evidence, not a passing result.')
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
    if obj.certificate_type not in CERTIFICATE_TYPES:
        raise HTTPException(400, 'Select a valid certificate type: ' + ', '.join(CERTIFICATE_TYPES))
    snapshot = obj.certificate_summary
    if not snapshot:
        raise HTTPException(400, 'Refresh certificate summaries before requesting approval')
    live = None
    if db is not None:
        live = capture(db, obj)
        # Never silently replace reviewed evidence. Changes require an explicit refresh.
        if snapshot.get('testing_scope') and live.get('testing_scope') != snapshot['testing_scope']:
            raise HTTPException(409, 'Linked testing scope changed since capture. Refresh the certificate and obtain full reapproval.')
        for field in ('assigned_testers', 'execution_population_basis', 'execution', 'defects', 'severity', 'execution_ids', 'defect_ids', 'defect_scope_cycle_ids', 'observations', 'security', 'execution_results', 'cycle_results', 'defect_results', 'change_request_ids', 'change_description', 'conditional_observations'):
            if live.get(field) != snapshot.get(field):
                raise HTTPException(409, 'Linked evidence changed since capture. Refresh the certificate and obtain full reapproval.')
        for field in ('change_type', 'business_defect_number', 'previous_request_id'):
            if field in snapshot and live.get(field) != snapshot[field]:
                raise HTTPException(409, 'Linked change details changed since capture. Refresh the certificate and obtain full reapproval.')
        previous_fields = snapshot.get('certificate_fields') or {}
        current_fields = live.get('certificate_fields') or {}
        if any(previous_fields.get(key, '') != current_fields.get(key, '')
               for key in previous_fields.keys() | current_fields.keys()):
            raise HTTPException(409, 'Certificate details changed since capture. Refresh the certificate and obtain full reapproval.')
    evidence = live or snapshot
    if obj.certificate_type in CLEARANCE_TYPES:
        validate_common_clearance_requirements(evidence, obj.certificate_type)
    if obj.certificate_type == 'Full Clearance':
        invalid_results = {
            status: count
            for status, count in evidence['execution']['counts'].items()
            if count and status not in FULL_CLEARANCE_EXECUTION_STATUSES
        }
        if invalid_results:
            labels = ', '.join(f'{status}: {count}' for status, count in sorted(invalid_results.items()))
            raise HTTPException(
                400,
                'Full Clearance requires every applicable test to be Pass or Retest Passed; '
                f'NA is allowed. Blocking results: {labels}',
            )
        if evidence['open_critical_high']:
            raise HTTPException(400, 'Full Clearance cannot be issued while linked Critical or High defects remain open, including Deferred defects')
    elif obj.certificate_type == 'Conditional Clearance':
        validate_conditional_clearance_requirements(evidence)


def validate_common_clearance_requirements(evidence, certificate_type):
    environment = str(evidence.get('environment') or '').strip()
    if not environment:
        raise HTTPException(400, f'{certificate_type} requires a non-blank tested environment')
    if environment.casefold() not in CLEARANCE_ENVIRONMENTS:
        raise HTTPException(400, f'{certificate_type} requires a valid tested environment: '
                            + ', '.join(ENVIRONMENT_PIPELINE_ORDER[:-1]))
    if evidence.get('source_status') not in CLEARANCE_SOURCE_STATUSES:
        raise HTTPException(400, f'{certificate_type} requires the linked Functional Request '
                            'to have completed QA and be eligible for clearance')
    cycles = evidence.get('cycle_results') or []
    if not cycles or any(str(cycle.get('environment') or '').strip().casefold() != environment.casefold()
                         for cycle in cycles):
        raise HTTPException(400, f'{certificate_type} requires a linked Test Cycle matching the selected environment')
    incomplete_cycles = [cycle for cycle in cycles if cycle.get('status') != 'Completed']
    if incomplete_cycles:
        labels = ', '.join(str(cycle.get('id')) for cycle in incomplete_cycles)
        raise HTTPException(400, f'{certificate_type} requires every matching Test Cycle to be Completed (cycle IDs: {labels})')
    if not (evidence.get('execution') or {}).get('total'):
        raise HTTPException(400, f'{certificate_type} requires linked test execution evidence for the selected environment')
    counts = evidence['execution'].get('counts') or {}
    if not any(count for status, count in counts.items() if status in set(EXECUTION_STATUSES) - {'Not Executed'}):
        raise HTTPException(400, f'{certificate_type} requires at least one recorded test result; Not Executed alone is not evidence')


def has_documented_text(value):
    """Empty rich-text markup or an image alone is not a written condition."""
    text = re.sub(r'<!--.*?-->|<[^>]*>', '', str(value or ''), flags=re.S)
    text = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', text)
    text = unescape(text).replace('\u200b', '').replace('\ufeff', '')
    return any(char.isalnum() for char in text)


def validate_conditional_clearance_requirements(evidence):
    if any(count and status not in EXECUTION_STATUSES
           for status, count in evidence['execution']['counts'].items()):
        raise HTTPException(400, 'Conditional Clearance requires recognized test execution statuses')
    fields = evidence.get('certificate_fields') or {}
    missing = []
    manual = evidence.get('conditional_observations') or ''
    # Manual observations replace the generated section, so markup-only manual
    # content must not silently hide the linked conditions from approvers.
    if not (has_documented_text(manual) if manual.strip() else
            any(has_documented_text(row.get('observation')) for row in evidence.get('observations', []))):
        missing.append('conditions / observations (enter them or capture linked open defects)')
    for key, label in [('residual_risk_notes', 'residual-risk remarks'),
                       ('conditional_mitigation', 'mitigation')]:
        if not has_documented_text(fields.get(key)):
            missing.append(label)
    target_date = str(fields.get('conditional_target_date') or '').strip()
    if target_date:
        try:
            date.fromisoformat(target_date)
        except ValueError:
            missing.append('valid target date when provided')
    if missing:
        raise HTTPException(400, 'Conditional Clearance requires documented ' + ', '.join(missing) + ' before submission or approval')


def change_metadata_fields(obj):
    """Print change identity once, preferring the reviewed certificate snapshot.

    Older snapshots did not capture change classification or references.
    Label their linked-request fallback explicitly without altering evidence.
    """
    snapshot = obj.certificate_summary or {}
    source = obj.source_functional_request
    parent = source.qa_request if source else None
    change_type = snapshot.get('change_type', getattr(parent, 'change_type', None))
    fields = [
        ('CR Number/EPIC Number', snapshot.get('change_request_ids', obj.change_request_ids) or 'Not recorded'),
        ('Change Description', snapshot.get('change_description', obj.change_description) or 'Not recorded'),
        ('Change Type', change_type or 'Not recorded'),
    ]
    reference_fields = ['change_type']
    if change_type == 'Bug Fix':
        fields.append(('Defect Number (Raised By Business)', snapshot.get('business_defect_number', getattr(parent, 'business_defect_number', None)) or 'Not recorded'))
        reference_fields.append('business_defect_number')
    if change_type in {'Bug Fix', 'Enhancement'}:
        fields.append(('Previous Completed Request ID', snapshot.get('previous_request_id', getattr(parent, 'bug_fix_source_request_id', None)) or 'Not recorded'))
        reference_fields.append('previous_request_id')
    if snapshot and any(field not in snapshot for field in reference_fields):
        fields.append(('Change Reference Source', 'Change type and references not captured in this older revision are shown from the linked QA request.'))
    return fields


def markdown_tables(snapshot):
    def table(headers, rows):
        def cell(value): return str(value).replace('|', '\\|').replace('\n', ' ')
        return '\n'.join(['| ' + ' | '.join(map(cell, headers)) + ' |', '| ' + ' | '.join(['---'] * len(headers)) + ' |'] + ['| ' + ' | '.join(map(cell, row)) + ' |' for row in rows])
    e = snapshot['execution']
    unique_population = snapshot.get('execution_population_basis') == EXECUTION_POPULATION_BASIS
    execution_title = ('Section B – QA Unique Test Case Execution Summary' if unique_population
                       else 'Section B – QA Test Case Execution Summary (Legacy Slot-Based)')
    population_header = 'Unique test cases' if unique_population else 'Execution slots'
    return [
        (execution_title, table([population_header, *EXECUTION_STATUSES, 'Pass %'], [[e['total'], *[e['counts'].get(s, 0) for s in EXECUTION_STATUSES], e['pass_pct'] if e['pass_pct'] is not None else 'NA']])),
        ('Section C – QA Defect Status Summary', table(['Status', 'Count'], [(s, snapshot['defects']['counts'].get(s, 0)) for s in DEFECT_BUCKETS if snapshot['defects']['counts'].get(s, 0) > 0] + [('Total', snapshot['defects']['total'])])),
        ('Defect Severity-wise Breakdown', table(['Severity', 'Open', 'Closed', 'Total'], [[r['severity'], r['open'], r['closed'], r['total']] for r in snapshot['severity']]))]
