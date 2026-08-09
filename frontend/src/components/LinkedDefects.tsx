import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { Badge } from './Common'
import { DefectOut } from '../types'

export default function LinkedDefects({ query, title = 'Linked Defects' }: { query: string; title?: string }) {
  const navigate = useNavigate()
  const [items, setItems] = useState<DefectOut[]>([])
  useEffect(() => {
    let active = true
    api.get<DefectOut[]>(`/api/defects?${query}`)
      .then((rows) => { if (active) setItems(rows) })
      .catch(() => { if (active) setItems([]) })
    return () => { active = false }
  }, [query])
  if (!items.length) return null
  return <section className="linked-defects-panel">
    <div><strong>{title}</strong><span>{items.length}</span></div>
    <div>{items.map((defect) => <button key={defect.id} type="button" onClick={() => navigate(`/defects?open=${encodeURIComponent(defect.defect_key)}`)}>
      <span><b>{defect.defect_key}</b><small>{defect.title}</small></span><Badge status={defect.status} /><em className={`defect-severity ${defect.severity.toLowerCase()}`}>{defect.severity}</em>
    </button>)}</div>
  </section>
}
