import React, { useState } from 'react'
import { api } from '../../api'
import { Card, ErrorText, PageHeader, Table } from '../../components/Common'
import { REPORTS } from '../../constants'

const GROUPS = ['Operational', 'Security', 'Management']
const IST_OFFSET = '+05:30'

function asIstDateTime(date: string, time: string): string {
  return date ? `${date}T${time}${IST_OFFSET}` : ''
}

export default function Reports() {
  const [error, setError] = useState<unknown>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  async function download(key: string, format: string) {
    setBusyKey(`${key}-${format}`)
    setError(null)
    try {
      const label = dateFrom || dateTo ? `Created date (IST): ${dateFrom || 'Beginning'} to ${dateTo || 'Today'}` : ''
      await api.downloadReport(key, format, label, asIstDateTime(dateFrom, '00:00:00'), asIstDateTime(dateTo, '23:59:59.999'))
    } catch (err) { setError(err) } finally { setBusyKey(null) }
  }

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Reports & Export Centre"
        subtitle="Every export embeds report name, module, generated-by/at, applied filters and total record count in the file header. Access is governed by your logged-in role."
      />
      <Card title="Report date range" subtitle="Dates use India Standard Time (IST). Exports include only records created or logged within this period. Leave both dates blank for all available data.">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
          <label><span className="muted small">From</span><input type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} /></label>
          <label><span className="muted small">To</span><input type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} /></label>
          {(dateFrom || dateTo) && <button className="btn btn-sm" onClick={() => { setDateFrom(''); setDateTo('') }}>Clear range</button>}
        </div>
      </Card>
      {GROUPS.map((group) => (
        <Card key={group} title={`${group} Reports`}>
          <Table
            tableId={`reports-${group.toLowerCase()}`}
            rowKey="key"
            rows={REPORTS.filter((r) => r.group === group)}
            columns={[
              { key: 'label', header: 'Report' },
              { key: 'description', header: 'Purpose' },
              {
                key: 'export', header: 'Export', filterable: false,
                render: (r) => (
                  <div style={{ display: 'flex', gap: 8 }}>
                    {['xlsx', 'pdf', 'csv'].map((fmt) => (
                      <button key={fmt} className="btn btn-sm" disabled={busyKey === `${r.key}-${fmt}`}
                              onClick={() => download(r.key, fmt)}>
                        {busyKey === `${r.key}-${fmt}` ? '...' : fmt.toUpperCase()}
                      </button>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        </Card>
      ))}
    </div>
  )
}
