import { RepeatableGroupField, RepeatableGroupRow } from '../components/Common'

// One "SAST component" = one repository, with its own branch/commit/tech
// stack/build number -- the "+" on the SAST step adds a whole new one of
// these (not just another URL), since a project can have several repos each
// needing their own full set of details.
export const SAST_COMPONENT_FIELDS: RepeatableGroupField[] = [
  { key: 'repository_url', label: 'Repository URL' },
  { key: 'git_branch', label: 'Branch' },
  { key: 'commit_id', label: 'Commit ID' },
  { key: 'technology_stack', label: 'Tech Stack' },
  { key: 'build_number', label: 'Build Number' },
]
export function blankSastComponent(): RepeatableGroupRow {
  return { repository_url: '', git_branch: '', commit_id: '', technology_stack: '', build_number: '' }
}

// One "DAST target" = one URL to scan, with its own environment/auth
// requirement/credentials -- the "+" adds a whole new target, since a
// project can have more than one URL to test. Test Credentials only shows
// (and only matters) once that target's own Authentication Required is
// ticked. No target_release field -- Target Release Date is already
// collected once, on the QA Request itself (see the Details step).
export interface DastComponent {
  application_url: string
  environment: string
  authentication_required: boolean
  test_credentials: string
}
export function blankDastComponent(): DastComponent {
  return { application_url: '', environment: '', authentication_required: false, test_credentials: '' }
}

// The full shape of the "Raise QA Request" / "Edit Request" wizard's form
// state. Every wizard step (see ./steps/*) reads/writes a slice of this same
// object -- see NewRequestModal.tsx for how it's initialized (blank, or
// pre-filled from an existing request being edited).
export const EMPTY_FORM = {
  department: '', application_name: '', application_owner: '', cr_number: '',
  epic_number: '', change_type: 'New', vendor_si_partner: '', technology_stack: '',
  release_version: '', build_number: '', environment: 'SIT', target_promotion_environment: 'UAT',
  request_types: [] as string[],
  request_type_other: '',
  target_release_date: '', remarks: '', checked_items: [] as string[],
  // Classification (Priority + Risk Rating/Category) is collected
  // independently per request type -- see the 'functional' step and the top
  // of each of the sast/dast/performance steps -- instead of
  // once, shared, on "Application & Change Details" (e.g. SAST
  // might be Low priority while Performance Testing on the same QA Request
  // is High). Field names below match the backend
  // schemas.QARequestCreate classification fields exactly.
  functional_priority: 'Medium', functional_risk_rating: 'Medium',
  sast_priority: 'Medium', sast_risk_category: 'Medium',
  // Optional -- collected alongside Repository Details on the SAST step
  // (see SASTRequest.hash_value); not required to raise the request.
  sast_hash_value: '',
  dast_priority: 'Medium', dast_risk_category: 'Medium',
  performance_priority: 'Medium', performance_risk_category: 'Medium',
  // Shown only while "SAST" is ticked -- seeds the auto-created SAST request
  // at raise time instead of leaving it for later on the SAST module page.
  // Each entry is one full SAST component (repo + branch + commit + tech
  // stack + build number) -- the "+" adds another whole component, since a
  // project can have more than one repository to scan.
  sast_components: [blankSastComponent()] as RepeatableGroupRow[],
  // Requester's own self-declaration against SAST's own "Security Readiness"
  // checklist (DEFAULT_SAST_CHECKLIST_ITEMS) -- seeds the auto-created SAST
  // request's checklist at raise time (same pattern as checked_items above,
  // for Functional's checklist). One mandatory item here also blocks the
  // SAST request's own Submit later if left unticked (see
  // routers/sast_dast.py::_require_checklist_ready).
  sast_checked_items: [] as string[],
  // Shown only while "DAST" is ticked -- same idea, for the auto-created DAST
  // request. Each entry is one full DAST target (URL + environment + auth +
  // credentials) -- the "+" adds another whole target.
  dast_components: [blankDastComponent()] as DastComponent[],
  // Requester's own self-declaration against DAST's own "Security Readiness"
  // checklist (DEFAULT_DAST_CHECKLIST_ITEMS) -- same idea as
  // sast_checked_items above (three mandatory items here).
  dast_checked_items: [] as string[],
  // Shown only while "Performance Testing" is ticked -- just the Annexure
  // VIII request type (Load/Stress/Spike Testing), which has no gateway
  // equivalent. change_type/vendor_si_partner/technology_stack/
  // release_version/build_number/target_promotion_environment are NOT
  // collected again here -- they're already collected once above, on
  // "Application & Change Details", and are delegated straight from there
  // when the Performance request is created (see backend
  // routers/qa_requests.py::_sync_linked_child_requests). Hash Value has no
  // gateway equivalent and is simply filled in later on the Performance
  // request's own page, once raised.
  performance_request_types: [] as string[],
  // Requester's own self-declaration against the 19-item "L1: Pre-Testing
  // Readiness Checklist" (DEFAULT_PERFORMANCE_CHECKLIST_ITEMS) -- seeds the
  // auto-created Performance request's checklist at raise time (same
  // pattern as checked_items above).
  performance_checked_items: [] as string[],
}
export type QARequestForm = typeof EMPTY_FORM

// Every wizard step gets this one setter to update a single field of the
// form -- see NewRequestModal.tsx's `set` function.
export type SetField = <K extends keyof QARequestForm>(k: K, v: QARequestForm[K]) => void

// The QA Request form is split into a wizard (rather than one long scrolling
// page) -- a fixed first/last pair of steps, plus a dedicated page per
// request type that needs its own extra details (SAST/DAST/Performance).
export interface WizardStep { key: string; label: string }
