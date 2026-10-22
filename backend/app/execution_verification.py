"""Verification coverage is reporting evidence, never a result-entry lock."""
from .defect_workflow import verified_for


def gaps(execution):
    cycle = execution.cycle
    latest = max(execution.runs, key=lambda run: run.attempt_no, default=None)
    environment = (latest.retest.environment if latest and latest.retest else cycle.environment if cycle else '') or ''
    environment = environment.strip()
    result = []
    for defect in execution.linked_defects:
        if defect.status in {'Deferred', 'Rejected', 'Duplicate', 'Not a Defect', 'Change Request Raised'} or (
                defect.status == 'Closed' and defect.resolution_type == 'Accepted Risk'):
            continue
        expected = defect.workflow.get('qa_environment') if defect.modern_workflow else None
        reasons, codes = [], []
        if latest and latest.retest and (latest.retest.environment != cycle.environment or latest.retest.pinned_version_id != execution.pinned_version_id):
            codes.append('execution_context_changed')
            reasons.append('The cycle environment or pinned testcase differs from the saved attempt context.')
        if expected and expected.casefold() != environment.casefold():
            codes.append('environment_mismatch')
            reasons.append(f'Tested in {environment or "an unspecified environment"}; configured QA environment is {expected}.')
        verified = verified_for(defect, environment, execution_id=execution.id) if defect.modern_workflow else (
            execution.id in defect.verified_execution_ids if defect.requires_execution_verification else defect.status == 'Closed')
        if not verified:
            codes.append('verification_pending')
            reasons.append('QA verification for this execution and environment is pending.')
        if defect.status != 'Closed':
            codes.append('defect_open')
            reasons.append(f'Defect workflow remains {defect.status}.')
        if latest and latest.status in {'Fail', 'Blocked'} and defect.status == 'Closed':
            codes.append('closed_defect_failed_result')
            reasons.append('The latest result is Failed or Blocked while the linked defect remains Closed; review whether to reopen it.')
        if codes:
            result.append(dict(execution_id=execution.id, test_case_key=execution.test_case.test_case_key if execution.test_case else None,
                cycle_key=cycle.cycle_key if cycle else None, defect_id=defect.id, defect_key=defect.defect_key,
                defect_status=defect.status, environment=environment, expected_environment=expected,
                result=execution.status, codes=codes, message=' '.join(reasons)))
    external = {}
    for run in execution.runs:
        for link in run.defects:
            if not link.is_historical and not (link.defect_url or '').startswith('/defects'):
                external[link.defect_key] = link
    for key, link in external.items():
        unresolved = (link.defect_status or 'Open').upper() not in {'RESOLVED', 'CLOSED'}
        failed_closed = not unresolved and latest and latest.status in {'Fail', 'Blocked'}
        if unresolved or failed_closed:
            result.append(dict(execution_id=execution.id, test_case_key=execution.test_case.test_case_key if execution.test_case else None,
                cycle_key=cycle.cycle_key if cycle else None, defect_id=None, defect_key=key,
                defect_status=link.defect_status or 'Open', environment=environment, expected_environment=None,
                result=execution.status, codes=['external_verification_pending' if unresolved else 'closed_external_failed_result'], message='External defect resolution has not been confirmed.' if unresolved else 'The latest result is Failed or Blocked while the external reference is resolved or closed; review its tracker status.'))
    return result


def summary(rows):
    return dict(total=len(rows), executions=len({row['execution_id'] for row in rows}),
        environment_mismatches=sum('environment_mismatch' in row['codes'] for row in rows))
