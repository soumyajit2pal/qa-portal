import { useEffect, useState } from 'react'
import { api } from '../../api'
import { ChecklistTemplateItemOut } from '../../types'

// Every readiness checklist (Functional/SAST/DAST/Performance) is
// Admin-configurable now (Admin > Readiness Checklist Configuration, see
// backend checklist_config.py) -- the wizard steps below used to import a
// static, hand-maintained list from constants.ts that had to be kept in
// sync with the backend's own hardcoded constants.py list by hand. Both
// sides now read the exact same live source (models.ChecklistTemplateItem)
// instead, so there's nothing left to drift out of sync, and an Admin's
// edit shows up here immediately without a frontend deploy.
//
// Order matters: item i's evidence upload is keyed by its position in this
// list (see ChecklistEvidencePicker/backend's checklist-evidence endpoints),
// which must line up with the order the backend actually seeds the real
// checklist rows in at Submit time -- both this hook and the backend read
// the same DB rows ordered by sort_order, so they always agree.
export function useChecklistTemplate(module: 'FUNCTIONAL' | 'SAST' | 'DAST' | 'PERFORMANCE') {
  const [items, setItems] = useState<ChecklistTemplateItemOut[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    api.get<ChecklistTemplateItemOut[]>(`/api/checklist-config/${module}`)
      .then((r) => { if (active) setItems(r) })
      .catch((err) => { if (active) setError(err) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [module])

  return { items, loading, error }
}
