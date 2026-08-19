import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { PageHeader, Card, ErrorText } from '../../components/Common'
import ConfirmModal from '../../components/ConfirmModal'
import { IconPlus } from '../../components/Icons'
import { ChecklistTemplateItemOut } from '../../types'

// Admin > Readiness Checklist Configuration -- reported directly: "I want to
// make configurable readiness checklist, whatever I mention on that
// configuration will automatically behave like that configuration, for
// example if I make any checklist mandatory in that configuration, that will
// be mandatory." This page is that configuration surface for all four
// checklists in the app (Functional/SAST/DAST/Performance -- QA Clearance has
// no checklist). See backend checklist_config.py/routers/checklist_config.py
// and models.ChecklistTemplateItem for the full reasoning: editing an item
// here only ever affects requests raised from this point forward, never
// anything already in flight.
const MODULES: { key: string; label: string; detailLabel: string }[] = [
  { key: 'FUNCTIONAL', label: 'Functional Testing', detailLabel: 'Owner' },
  { key: 'SAST', label: 'SAST', detailLabel: 'Owner' },
  { key: 'DAST', label: 'DAST', detailLabel: 'Owner' },
  { key: 'PERFORMANCE', label: 'Performance Testing', detailLabel: 'Data Required from Department' },
]

function AddItemForm({ module, detailLabel, onAdded }: {
  module: string; detailLabel: string; onAdded: (item: ChecklistTemplateItemOut) => void
}) {
  const [item, setItem] = useState('')
  const [detail, setDetail] = useState('')
  const [mandatory, setMandatory] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const text = item.trim()
    if (!text) return
    setBusy(true)
    setError(null)
    try {
      const created = await api.post<ChecklistTemplateItemOut>(`/api/checklist-config/${module}`, {
        item: text, detail: detail.trim() || null, is_mandatory: mandatory,
      })
      setItem(''); setDetail(''); setMandatory(false)
      onAdded(created)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
      <input
        style={{ flex: 2, minWidth: 220 }}
        placeholder="New checklist item text..."
        value={item}
        onChange={(e) => setItem(e.target.value)}
      />
      <input
        style={{ flex: 1, minWidth: 160 }}
        placeholder={detailLabel}
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
      />
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', flex: '0 0 auto' }}>
        <input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} />
        <span className="small">Mandatory</span>
      </label>
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !item.trim()}>
        <IconPlus width={13} height={13} /> Add
      </button>
      <ErrorText error={error} />
    </form>
  )
}

function ChecklistItemRow({ item, detailLabel, isFirst, isLast, onSaved, onDeleted, onMove }: {
  item: ChecklistTemplateItemOut
  detailLabel: string
  isFirst: boolean
  isLast: boolean
  onSaved: (updated: ChecklistTemplateItemOut) => void
  onDeleted: (id: number) => void
  onMove: (item: ChecklistTemplateItemOut, direction: 'up' | 'down') => void
}) {
  const [itemText, setItemText] = useState(item.item)
  const [detail, setDetail] = useState(item.detail || '')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Keep local edit state in sync if the underlying item changes from
  // outside (e.g. Restore Defaults resets the whole list).
  useEffect(() => { setItemText(item.item) }, [item.item])
  useEffect(() => { setDetail(item.detail || '') }, [item.detail])

  async function patch(data: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const updated = await api.patch<ChecklistTemplateItemOut>(
        `/api/checklist-config/${item.module}/${item.id}`, data,
      )
      onSaved(updated)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function saveText() {
    const trimmedItem = itemText.trim()
    const trimmedDetail = detail.trim()
    if (!trimmedItem) { setItemText(item.item); return }
    if (trimmedItem === item.item && trimmedDetail === (item.detail || '')) return
    await patch({ item: trimmedItem, detail: trimmedDetail || null })
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await api.del(`/api/checklist-config/${item.module}/${item.id}`)
      onDeleted(item.id)
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <tr style={{ opacity: item.active ? 1 : 0.55 }}>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button type="button" className="btn btn-sm" disabled={busy || isFirst} onClick={() => onMove(item, 'up')} title="Move up">&uarr;</button>{' '}
        <button type="button" className="btn btn-sm" disabled={busy || isLast} onClick={() => onMove(item, 'down')} title="Move down">&darr;</button>
      </td>
      <td style={{ minWidth: 260 }}>
        <input
          style={{ width: '100%' }}
          value={itemText}
          disabled={busy}
          onChange={(e) => setItemText(e.target.value)}
          onBlur={saveText}
        />
      </td>
      <td style={{ minWidth: 160 }}>
        <input
          style={{ width: '100%' }}
          value={detail}
          disabled={busy}
          placeholder={detailLabel}
          onChange={(e) => setDetail(e.target.value)}
          onBlur={saveText}
        />
      </td>
      <td>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
          <input
            type="checkbox"
            checked={item.is_mandatory}
            disabled={busy}
            onChange={(e) => patch({ is_mandatory: e.target.checked })}
          />
        </label>
      </td>
      <td>
        <button
          type="button"
          className={`btn btn-sm ${item.active ? '' : 'btn-danger'}`}
          disabled={busy}
          onClick={() => patch({ active: !item.active })}
        >
          {item.active ? 'Active' : 'Inactive'}
        </button>
      </td>
      <td>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
          Delete
        </button>
        {confirmDelete && (
          <ConfirmModal
            title="Delete this checklist item?"
            message={
              <div>
                <p>Delete <strong>{item.item}</strong> from this module's configuration?</p>
                <p className="muted small">
                  Requests already raised keep their own copy of this item untouched -- this only
                  changes what gets seeded onto new requests going forward. If you just want to stop
                  offering it without losing the definition, use "Inactive" instead.
                </p>
              </div>
            }
            confirmLabel="Delete" cancelLabel="Keep it" destructive busy={busy}
            onConfirm={remove} onCancel={() => setConfirmDelete(false)}
          />
        )}
        <ErrorText error={error} title="Could not save this item" />
      </td>
    </tr>
  )
}

function ChecklistModulePanel({ module, detailLabel }: { module: string; detailLabel: string }) {
  const [items, setItems] = useState<ChecklistTemplateItemOut[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [restoring, setRestoring] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await api.get<ChecklistTemplateItemOut[]>(`/api/checklist-config/${module}/all`)
      setItems(rows)
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [module])

  useEffect(() => { load() }, [load])

  function replaceItem(updated: ChecklistTemplateItemOut) {
    setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)).sort((a, b) => a.sort_order - b.sort_order))
  }

  async function moveItem(item: ChecklistTemplateItemOut, direction: 'up' | 'down') {
    const sorted = [...items].sort((a, b) => a.sort_order - b.sort_order)
    const idx = sorted.findIndex((x) => x.id === item.id)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return
    const other = sorted[swapIdx]
    try {
      const [a, b] = await Promise.all([
        api.patch<ChecklistTemplateItemOut>(`/api/checklist-config/${module}/${item.id}`, { sort_order: other.sort_order }),
        api.patch<ChecklistTemplateItemOut>(`/api/checklist-config/${module}/${other.id}`, { sort_order: item.sort_order }),
      ])
      setItems((prev) => {
        const next = prev.map((x) => (x.id === a.id ? a : x.id === b.id ? b : x))
        return next.sort((x, y) => x.sort_order - y.sort_order)
      })
    } catch (err) {
      setError(err)
    }
  }

  async function restoreDefaults() {
    setRestoring(true)
    setError(null)
    try {
      const rows = await api.post<ChecklistTemplateItemOut[]>(`/api/checklist-config/${module}/restore-defaults`)
      setItems(rows)
      setConfirmRestore(false)
    } catch (err) {
      setError(err)
    } finally {
      setRestoring(false)
    }
  }

  const sorted = [...items].sort((a, b) => a.sort_order - b.sort_order)

  return (
    <Card title={`${MODULES.find((m) => m.key === module)?.label} Checklist`}>
      <p className="muted small" style={{ marginTop: -4, marginBottom: 12 }}>
        Seeded onto every new request's own checklist from here at raise time. Mandatory items must be
        self-declared ready by the requester before the QA Request can be raised. Changing this list
        never affects a request already in progress -- only what gets seeded going forward.
      </p>
      <AddItemForm module={module} detailLabel={detailLabel} onAdded={(created) => setItems((prev) => [...prev, created])} />
      <ErrorText error={error} />
      {loading ? (
        <p className="muted small">Loading...</p>
      ) : (
        <table className="simple-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Item</th>
              <th>{detailLabel}</th>
              <th>Mandatory</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item, i) => (
              <ChecklistItemRow
                key={item.id}
                item={item}
                detailLabel={detailLabel}
                isFirst={i === 0}
                isLast={i === sorted.length - 1}
                onSaved={replaceItem}
                onDeleted={(id) => setItems((prev) => prev.filter((x) => x.id !== id))}
                onMove={moveItem}
              />
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={6} className="muted small">No items configured for this checklist.</td></tr>
            )}
          </tbody>
        </table>
      )}
      <div style={{ marginTop: 14 }}>
        <button type="button" className="btn btn-sm" onClick={() => setConfirmRestore(true)}>
          Restore Defaults
        </button>
      </div>
      {confirmRestore && (
        <ConfirmModal
          title="Restore shipped defaults?"
          message={
            <div>
              <p>Delete every configured item for this checklist and reseed the original shipped defaults?</p>
              <p className="muted small">Requests already raised keep their own already-seeded checklist untouched.</p>
            </div>
          }
          confirmLabel="Restore defaults" cancelLabel="Cancel" destructive busy={restoring}
          onConfirm={restoreDefaults} onCancel={() => setConfirmRestore(false)}
        />
      )}
    </Card>
  )
}

export default function ChecklistConfig() {
  const [activeModule, setActiveModule] = useState(MODULES[0].key)
  const active = MODULES.find((m) => m.key === activeModule) || MODULES[0]

  return (
    <div>
      <PageHeader
        title="Readiness Checklist Configuration"
        subtitle="Configure every self-declaration checklist used across the QA Request wizard -- add, remove, reorder, or reword an item, and flip Mandatory on/off. Takes effect on the next request raised for that module."
      />
      <div className="wizard-steps" style={{ marginBottom: 16 }}>
        {MODULES.map((m) => (
          <button
            key={m.key}
            type="button"
            className={`wizard-step-btn ${m.key === activeModule ? 'active' : ''}`}
            onClick={() => setActiveModule(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <ChecklistModulePanel module={active.key} detailLabel={active.detailLabel} />
    </div>
  )
}
