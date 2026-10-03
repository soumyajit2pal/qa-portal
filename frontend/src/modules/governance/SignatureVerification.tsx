import React, { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { Card, ErrorText, PageHeader } from '../../components/Common'
import { IconShield, IconCheckCircle, IconWarning } from '../../components/Icons'
import { createLatestRequestGate } from '../../latestRequest'
import { formatDateTimeIST } from '../../time'
import { APPROVAL_STATE_LABELS, SignatureVerificationResult, signatureIntegrityLabel, verificationPresentation } from '../../signatureVerification'
import './SignatureVerification.css'

const MAX_PDF_BYTES = 20 * 1024 * 1024

function Evidence({ evidence }: { evidence: SignatureVerificationResult }) {
  return <div className="signature-evidence">
    <div className="signature-evidence-heading">
      <strong>{evidence.stage || 'Approval signature'}</strong>
      <span>{signatureIntegrityLabel(evidence.status)}</span>
    </div>
    <dl>
      <div><dt>Signed by</dt><dd>{evidence.signer || '—'}</dd></div>
      <div><dt>Signed at</dt><dd>{evidence.signed_at ? formatDateTimeIST(evidence.signed_at) : '—'}</dd></div>
      <div><dt>Record</dt><dd>{evidence.request_ref || '—'}</dd></div>
      <div><dt>Decision</dt><dd>{evidence.decision || '—'}</dd></div>
      <div className="signature-evidence-wide"><dt>Signature ID</dt><dd><code>{evidence.signature_id}</code></dd></div>
      {evidence.approval_state && <div className="signature-evidence-wide"><dt>Approval state</dt><dd className={evidence.approval_state !== 'CURRENT' ? 'signature-state-warning' : ''}>{APPROVAL_STATE_LABELS[evidence.approval_state]}</dd></div>}
      {evidence.intent && <div className="signature-evidence-wide"><dt>Intent</dt><dd>{evidence.intent}</dd></div>}
    </dl>
    {evidence.status !== 'VALID' && <p>{evidence.message}</p>}
  </div>
}

export default function SignatureVerification() {
  const [params] = useSearchParams()
  const [mode, setMode] = useState<'pdf' | 'id'>(params.get('id') ? 'id' : 'pdf')
  const [identifier, setIdentifier] = useState(params.get('id') || '')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<SignatureVerificationResult | null>(null)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const gate = useRef(createLatestRequestGate())
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => () => gate.current.invalidate(), [])
  useEffect(() => {
    const id = params.get('id')
    if (id) { clearResult(); setMode('id'); setIdentifier(id) }
  }, [params.get('id')])

  function clearResult() {
    gate.current.invalidate()
    setResult(null); setError(null); setCheckedAt(null); setBusy(false)
  }

  function chooseFile(next: File | null) {
    clearResult()
    setFile(null)
    if (next && !next.name.toLowerCase().endsWith('.pdf')) {
      setError('Choose a PDF exported from the portal.'); return
    }
    if (next && next.size > MAX_PDF_BYTES) {
      setError('PDF must be 20 MB or smaller.'); return
    }
    setFile(next)
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault()
    const id = identifier.trim().toUpperCase()
    if (mode === 'id' && !/^ESIG-[A-Z0-9-]{1,75}$/.test(id)) {
      setError('Enter the complete signature ID starting with ESIG-.'); return
    }
    if (mode === 'pdf' && !file) { setError('Choose a PDF to verify.'); return }
    const generation = gate.current.begin()
    setBusy(true); setError(null); setResult(null); setCheckedAt(null)
    try {
      const verified = mode === 'pdf'
        ? await api.uploadForm<SignatureVerificationResult>('/api/signatures/verify-pdf', { file }, 600_000)
        : await api.post<SignatureVerificationResult>('/api/signatures/check', { signature_id: id })
      if (gate.current.isCurrent(generation)) { setResult(verified); setCheckedAt(new Date()) }
    } catch (err) {
      if (gate.current.isCurrent(generation)) setError(err)
    } finally {
      if (gate.current.isCurrent(generation)) setBusy(false)
    }
  }

  const presentation = result ? verificationPresentation(result, mode) : null
  const evidence = result?.signatures || (result?.signature_id ? [result] : [])
  return <div className="signature-verifier">
    <PageHeader title="Verify Signature" subtitle="Check a portal PDF for changes, or verify a recorded approval signature." />
    <div className="signature-verifier-layout">
      <Card>
        <div className="signature-verifier-tabs" role="tablist" aria-label="Verification method">
          <button type="button" role="tab" aria-selected={mode === 'pdf'} aria-controls="signature-check-panel" onClick={() => { clearResult(); setMode('pdf') }}>Verify PDF</button>
          <button type="button" role="tab" aria-selected={mode === 'id'} aria-controls="signature-check-panel" onClick={() => { clearResult(); setMode('id') }}>Check signature ID</button>
        </div>
        <form id="signature-check-panel" onSubmit={verify}>
          {mode === 'pdf' ? <>
            <h3>Has this document changed?</h3>
            <p>Upload the original PDF downloaded from the portal. Verification checks the document and its recorded approval signatures.</p>
            <div className="signature-file-picker" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!busy) chooseFile(event.dataTransfer.files[0] || null) }}>
              <IconShield width={30} height={30} />
              <strong>{file ? file.name : 'Choose a PDF or drop it here'}</strong>
              <span>{file ? `${(file.size / 1024).toFixed(0)} KB · Ready to verify` : 'PDF files up to 20 MB'}</span>
              <input ref={fileInput} type="file" accept=".pdf,application/pdf" aria-label="PDF to verify" disabled={busy} onChange={(event) => chooseFile(event.target.files?.[0] || null)} />
            </div>
          </> : <>
            <h3>Check an approval signature</h3>
            <p>Copy the full signature ID from the approval record or exported PDF.</p>
            <label className="signature-id-field">Signature ID
              <input value={identifier} placeholder="ESIG-XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" maxLength={80} spellCheck={false} autoComplete="off" disabled={busy} onChange={(event) => { clearResult(); setIdentifier(event.target.value) }} />
            </label>
            <p className="signature-check-note">An ID check verifies the approval evidence. Upload the PDF to confirm the document itself has not changed.</p>
          </>}
          <ErrorText error={error} />
          <button className="btn btn-primary" type="submit" disabled={busy || (mode === 'pdf' ? !file : !identifier.trim())}>
            <IconShield width={16} height={16} /> {busy ? 'Verifying…' : mode === 'pdf' ? 'Verify PDF' : 'Check signature'}
          </button>
          <p className="signature-verifier-privacy">PDFs are used only for this check and are not retained. Only records you can access in the selected workspace are shown.</p>
        </form>
      </Card>
      <aside className="signature-verifier-guide">
        <IconShield width={24} height={24} />
        <h3>What gets checked</h3>
        <p><strong>Approval evidence</strong><br />Signer, decision, timestamp and signature ID match the original server seal.</p>
        <p><strong>Document integrity</strong><br />Every byte of the PDF matches the portal export.</p>
        <p><strong>Approval state</strong><br />See whether an approval is current, replaced, reset or on hold.</p>
        <p>Older signatures without an original integrity seal are shown as unconfirmed.</p>
      </aside>
    </div>
    {result && presentation && <section className={`signature-verification-result ${presentation.tone}`} aria-live="polite" role="status">
      <div className="signature-result-heading">
        {presentation.tone === 'success' ? <IconCheckCircle width={24} height={24} /> : <IconWarning width={24} height={24} />}
        <div><h3>{presentation.title}</h3><p>{result.message}</p></div>
      </div>
      {result.document_intact && <p className="signature-document-intact"><strong>Document: verified.</strong> Unchanged since this PDF was exported.</p>}
      {evidence.map((item, index) => item.signature_id
        ? <Evidence evidence={item} key={item.signature_id} />
        : <p key={index}>{item.message}</p>)}
      {checkedAt && <small>Checked {formatDateTimeIST(checkedAt)}</small>}
    </section>}
  </div>
}
