"""Versioned workspace defect policies and build-specific verification rules.

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
        return [path[path.index(status) + 1], 'Deferred', 'Duplicate', 'Not a Defect', 'Rejected', 'Accept Risk']
    if status in ('Deferred', 'Reopened'):
        return ['In Progress']
    if status in ('Closed', 'Rejected', 'Not a Defect'):
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


def verified_for(obj, environment, build):
    if not getattr(obj, 'workflow_json', None) or not environment or not build:
        return False
    s = state(obj)
    if s.get('verification_invalidated') or (obj.status == 'Closed' and getattr(obj, 'resolution_type', None) not in (None, 'Fixed')):
        return False
    if obj.status in ('New', 'Triaged', 'In Progress', 'Ready for QA', 'Reopened'):
        return False
    results = [e for e in s.get('history', []) if e.get('kind') == 'verification'
               and e.get('iteration') == s.get('iteration', 0)
               and e.get('environment') == environment and e.get('build') == build]
    return bool(results and results[-1]['result'] == 'Passed')
