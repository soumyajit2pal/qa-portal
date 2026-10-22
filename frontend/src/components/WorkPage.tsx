import React, { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { hasWorkflowRole, hasWorkspaceRole, isSelectableUser } from '../constants'
import { useAuth } from '../context/AuthContext'
import { internalNavigationPath } from '../requestNavigation'
import { parseWorkPath, readWorkSnapshot, validSnapshot, WorkSnapshot, workKey, workPath } from '../workViewStore'
import { WorkSession, restoreRetained, useWorkScope } from './WorkViews'
import { ErrorText } from './Common'
import AddCasesModal from './AddCasesModal'
import { UserOption, FunctionalOut, DefectOut, DepartmentOut, DefectListOut, DefectLinkableExecutionOut, QARequestListOut, TestCycleOut, TestExecutionSummaryOut, TestProjectMyAccessOut } from '../types'
import { FunctionalDetail } from '../modules/functional/Functional'
import { CreateDefectModal, DefectDetail } from '../modules/test-management/Defects'
import { CreateObservationModal } from '../modules/test-management/Observations'

interface PageData {
  snapshot?: WorkSnapshot; users: UserOption[]; functional?: FunctionalOut; defect?: DefectOut
  departments?: DepartmentOut[]; defects?: DefectListOut[]; contexts?: DefectLinkableExecutionOut[]
  requests?: QARequestListOut[]; cycle?: TestCycleOut; summary?: TestExecutionSummaryOut; access?: TestProjectMyAccessOut
}
export default function WorkPage() {
  const location = useLocation(), navigate = useNavigate(), scope = useWorkScope(), { user } = useAuth()
  const target = parseWorkPath(location.pathname), token = new URLSearchParams(location.search).get('draft')
  const identity = target ? workKey(target) : ''
  const [data, setData] = useState<PageData | null>(null), [error, setError] = useState<unknown>(null), [retry, setRetry] = useState(0)
  const pageTitle = data?.functional?.request_id || data?.defect?.defect_key || (data?.cycle ? `Add testcases · ${data.cycle.cycle_key}` : target?.id === 'new' ? target.kind === 'observation' ? 'New observation' : 'New defect' : '')
  useEffect(() => {
    if (!pageTitle) return
    const previous = document.title
    document.title = `${pageTitle} — QualityOps`
    return () => { document.title = previous }
  }, [pageTitle])
  useEffect(() => {
    let active = true
    setData(null); setError(null)
    async function load() {
      if (!target) throw new Error('This work page does not exist.')
      const snapshot = token ? await readWorkSnapshot(token) : undefined
      if (token && !validSnapshot(snapshot, scope, target)) throw new Error('This draft has expired or belongs to another account or workspace. Return to the list to open a fresh view.')
      const users = await api.get<UserOption[]>('/api/auth/user-options').catch(() => [])
      let next: PageData = { users, snapshot }
      if (target.kind === 'functional') next.functional = await api.getFresh<FunctionalOut>(`/api/functional-requests/${target.id}`)
      else if (target.kind === 'add-cases') {
        const cycle = await api.getFresh<TestCycleOut>(`/api/test-execution/cycles/${target.id}`)
        const [summary, access, runners] = await Promise.all([
          api.getFresh<TestExecutionSummaryOut>(`/api/test-execution/cycles/${target.id}/executions/summary`),
          api.getFresh<TestProjectMyAccessOut>(`/api/test-projects/${cycle.project_id}/my-access`),
          api.get<UserOption[]>(`/api/test-projects/eligible-users?runner_only=true&project_id=${cycle.project_id}&cycle_id=${cycle.id}`),
        ])
        if (!access.can_execute || cycle.workspace_writable === false || ['Blocked', 'Completed'].includes(cycle.status)) throw new Error('This cycle is no longer available for adding testcases.')
        next = { ...next, users: runners, cycle, summary, access }
      } else {
        const defect = target.id === 'new' ? undefined : await api.getFresh<DefectOut>(`/api/defects/${target.id}`)
        const [departments, defects, contexts, requests] = await Promise.all([
          api.get<DepartmentOut[]>('/api/departments').catch(() => []), api.getAll<DefectListOut>('/api/defects').catch(() => []),
          api.get<DefectLinkableExecutionOut[]>('/api/test-execution/executions/blocked-or-failed').catch(() => []),
          api.getAll<QARequestListOut>('/api/qa-requests').catch(() => []),
        ])
        next = { ...next, defect, departments, defects, contexts, requests }
      }
      if (active) { if (snapshot) restoreRetained(scope, snapshot.lists); setData(next) }
    }
    load().catch(reason => { if (active) setError(reason) })
    return () => { active = false }
  }, [identity, token, scope, retry])
  const fallback = target?.kind === 'functional' ? '/functional-requests' : target && ['defect', 'observation'].includes(target.kind) ? '/defects' : '/test-execution'
  const back = () => navigate(internalNavigationPath(data?.snapshot?.returnTo) || fallback)
  if (!data || !target) return <div className="work-page-status"><button className="btn" onClick={back}>← Back to list</button>{error ? <><ErrorText error={error} /><button className="btn" onClick={() => setRetry(value => value + 1)}>Retry</button></> : <p role="status">Opening work page and restoring your draft…</p>}</div>
  return <WorkSession target={target} page snapshot={data.snapshot}>
    {target.kind === 'add-cases' && data.cycle && <AddCasesModal cycleId={data.cycle.id}
      canAssign={hasWorkflowRole(user, 'QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA') && hasWorkspaceRole(user, 'QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA')}
      requiresScopeChangeReason={data.cycle.status === 'In Progress' || (data.summary?.total_run_count || 0) > 0}
      runnerCandidates={data.users.filter(isSelectableUser)} onClose={back} onAdded={back} />}
    {data.functional && <FunctionalDetail req={data.functional} users={data.users} onClose={back} onChanged={functional => setData(current => current ? { ...current, functional } : current)} />}
    {data.defect && <DefectDetail defect={data.defect} users={data.users} departments={data.departments || []}
      requestDepartment={data.requests?.find(request => request.id === data.defect?.qa_request_id)?.department}
      defects={data.defects || []} contexts={data.contexts || []} onClose={back}
      onChanged={defect => setData(current => current ? { ...current, defect } : current)}
      onOpenDefect={defect => navigate(workPath({ kind: 'defect', id: defect.id }))} />}
    {target.kind === 'defect' && target.id === 'new' && <CreateDefectModal standalone contexts={data.contexts || []} requests={data.requests || []}
      onClose={back} onCreated={defect => navigate(workPath({ kind: 'defect', id: defect.id }))} />}
    {target.kind === 'observation' && <CreateObservationModal requests={data.requests || []} onClose={back} onCreated={record => navigate(workPath({ kind: 'defect', id: record.id }))} />}
  </WorkSession>
}
