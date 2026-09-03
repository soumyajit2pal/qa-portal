import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { Card, ErrorText, PageHeader } from '../../components/Common'
import { RequestTypeConfigOut } from '../../types'


export default function RequestTypeConfig() {
  const [rows, setRows] = useState<RequestTypeConfigOut[]>([])
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setRows(await api.get<RequestTypeConfigOut[]>('/api/request-type-config'))
    } catch (err) {
      setError(err)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function toggle(row: RequestTypeConfigOut) {
    setBusyId(row.id)
    setError(null)
    try {
      const updated = await api.patch<RequestTypeConfigOut>(`/api/request-type-config/${row.id}`, {
        is_active: !row.is_active,
      })
      setRows((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (err) {
      setError(err)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Request Type Configuration"
        subtitle="Activate or deactivate the testing types offered when raising a QA Request. Disabled types remain visible in the form but cannot be selected."
      />
      <Card>
        <ErrorText error={error} />
        <table className="simple-table">
          <thead><tr><th>Order</th><th>Request Type</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id} style={{ opacity: row.is_active ? 1 : 0.6 }}>
                <td>{index + 1}</td>
                <td><strong>{row.request_type}</strong></td>
                <td>
                  <button
                    type="button"
                    className={`btn btn-sm ${row.is_active ? '' : 'btn-danger'}`}
                    disabled={busyId === row.id}
                    onClick={() => toggle(row)}
                  >
                    {row.is_active ? 'Active' : 'Disabled'}
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={3} className="muted small">Loading request types…</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
