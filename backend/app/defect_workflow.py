"""Versioned workspace defect policies and verification coverage rules.

Published policies are snapshotted on each new defect. Existing defects with no
snapshot retain their historical workflow. History entries are append-only.
"""
import json
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal


class WorkflowPolicy(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(default=1, ge=1)
    qa_environment: Literal['Dev', 'SIT', 'UAT', 'Pre-Production'] = 'UAT'
    business_acceptance: bool = False
    business_environment: Literal['UAT', 'Pre-Production'] = 'UAT'
    production_for_all: bool = False


def policy(raw):
    return WorkflowPolicy.model_validate(json.loads(raw) if raw else {}).model_dump()


def state(obj):
    return json.loads(getattr(obj, 'workflow_state_json', None) or '{}')


def production_required(obj):
    s = state(obj)
    return (policy(obj.workflow_json)['production_for_all'] or obj.environment == 'Production'
            or s.get('production_impact') == 'Affected'
            or any(e['environment'] == 'Production' for e in s.get('occurrences', [])))


def stages(obj):
    p = policy(obj.workflow_json)
    if obj.status in ('Not a Defect Review', 'Not a Defect', 'Change Request Raised'):
        outcome = 'Change Request Raised' if obj.status == 'Change Request Raised' else 'Not a Defect'
        return ['New', 'Triaged', 'In Progress', 'Not a Defect Review', outcome]
    result = ['New', 'Triaged', 'In Progress', 'Ready for QA', 'QA Testing']
    if p['business_acceptance']:
        result += ['Business Acceptance']
    if production_required(obj):
        result += ['Ready for Release', 'Production Verification']
    return result + ['Closed']


def transitions(obj):
    if not getattr(obj, 'workflow_json', None):
        return []
    path = stages(obj)
    status = obj.status
    if status == 'New':
        return ['Triaged']
    if status in ('Triaged', 'In Progress'):
        return [path[path.index(status) + 1], 'Deferred', 'Duplicate', 'Not a Defect Review', 'Rejected', 'Accept Risk']
    if status == 'Not a Defect Review':
        return ['Not a Defect', 'Change Request Raised', 'Reopened']
    if status in ('Deferred', 'Reopened'):
        return ['In Progress']
    if status in ('Closed', 'Rejected', 'Not a Defect', 'Change Request Raised'):
        return ['Reopened']
    if status == 'Duplicate':
        return []
    if status in path:
        return [path[path.index(status) + 1], 'Reopened']
    return []


def environment_for(obj, stage):
    p = policy(obj.workflow_json)
    return {'QA Testing': p['qa_environment'], 'Business Acceptance': p['business_environment'],
            'Production Verification': 'Production'}.get(stage)


_NON_VERIFIABLE_STATUSES = ('New', 'Triaged', 'In Progress', 'Ready for QA', 'Reopened')


def _verification_state_is_usable(obj, workflow_state):
    return not (
        workflow_state.get('verification_invalidated')
        or (obj.status == 'Closed' and getattr(obj, 'resolution_type', None) not in (None, 'Fixed'))
        or obj.status in _NON_VERIFIABLE_STATUSES
    )


def verified_for(obj, environment, build):
    """Return whether verification covers an execution context.

    While a modern defect is still moving through verification stages, build
    matching remains exact. Once the defect is Closed/Fixed, the verification
    applies to every non-empty build in the same environment. Builds remain
    recorded as audit evidence, but no longer partition closed-defect coverage.
    """
    if not getattr(obj, 'workflow_json', None) or not environment or not build:
        return False
    s = state(obj)
    if not _verification_state_is_usable(obj, s):
        return False
    results = [e for e in s.get('history', []) if e.get('kind') == 'verification'
               and e.get('iteration') == s.get('iteration', 0)
               and e.get('environment') == environment
               and (obj.status == 'Closed' or e.get('build') == build)]
    return bool(results and results[-1]['result'] == 'Passed')


def verified_records(obj):
    """Return real verification events currently counted as passed.

    The public list field retains its historical ``verified_builds`` shape for
    API compatibility. For Closed defects, one latest event per environment is
    returned so an older/failed build is never fabricated as verified merely
    because closed-defect coverage is now environment-scoped.
    """
    if not getattr(obj, 'workflow_json', None):
        return []
    s = state(obj)
    if not _verification_state_is_usable(obj, s):
        return []
    latest = {}
    for event in s.get('history', []):
        if (event.get('kind') != 'verification'
                or event.get('iteration') != s.get('iteration', 0)
                or not event.get('environment')
                or not event.get('build')):
            continue
        key = event['environment'] if obj.status == 'Closed' else (event['environment'], event['build'])
        latest[key] = event
    records = [
        {'environment': event['environment'], 'build': event['build']}
        for event in latest.values() if event.get('result') == 'Passed'
    ]
    return sorted(records, key=lambda item: (item['environment'], item['build']))
