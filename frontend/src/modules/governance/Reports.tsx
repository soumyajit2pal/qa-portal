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
      <Card className="report-period-card">
        <div className="report-period-heading">
          <div className="report-period-title">
            <span className="report-period-icon" aria-hidden="true">◷</span>
            <div>
              <span>Reporting period</span>
              <p>Limit every export to the records created or logged within this period.</p>
            </div>
          </div>
          <span className="report-period-timezone">IST · India Standard Time</span>
        </div>
        <div className="report-period-controls">
          <label className="report-period-field">
            <span>From date</span>
            <input aria-label="Report date range from" type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} />
          </label>
          <span className="report-period-arrow" aria-hidden="true">→</span>
          <label className="report-period-field">
            <span>To date</span>
            <input aria-label="Report date range to" type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} />
          </label>
          {(dateFrom || dateTo) && <button className="btn btn-sm report-period-clear" onClick={() => { setDateFrom(''); setDateTo('') }}>Reset period</button>}
        </div>
        <p className="report-period-note">Leave both dates empty to export all available historical records.</p>
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
