import React, { useState } from 'react'
import { api } from '@qa-portal/shared/api'
import { Card, ErrorText, PageHeader } from '@qa-portal/shared/components/Common'
import { REPORTS } from '@qa-portal/shared/constants'

const GROUPS = ['Operational', 'Security', 'Management']

export default function Reports() {
  const [error, setError] = useState<unknown>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  async function download(key: string, format: string) {
    setBusyKey(`${key}-${format}`)
    setError(null)
    try {
      await api.downloadReport(key, format)
    } catch (err) { setError(err) } finally { setBusyKey(null) }
  }

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Reports & Export Centre"
        subtitle="Every export embeds report name, module, generated-by/at, applied filters and total record count in the file header. Access is governed by your logged-in role."
      />
      {GROUPS.map((group) => (
        <Card key={group} title={`${group} Reports`}>
          <table>
            <thead><tr><th>Report</th><th>Export</th></tr></thead>
            <tbody>
              {REPORTS.filter((r) => r.group === group).map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td style={{ display: 'flex', gap: 8 }}>
                    {['xlsx', 'pdf', 'csv'].map((fmt) => (
                      <button key={fmt} className="btn btn-sm" disabled={busyKey === `${r.key}-${fmt}`}
                              onClick={() => download(r.key, fmt)}>
                        {busyKey === `${r.key}-${fmt}` ? '...' : fmt.toUpperCase()}
                      </button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  )
}
