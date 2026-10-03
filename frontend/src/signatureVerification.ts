export interface SignatureVerificationResult {
  status: 'VALID' | 'TAMPERED' | 'LEGACY' | 'UNVERIFIABLE'
  message: string
  signature_id?: string
  signer?: string
  signed_at?: string
  recorded_at?: string
  stage?: string
  decision?: string
  actor_role?: string
  intent?: string
  request_ref?: string
  approval_state?: 'CURRENT' | 'REPLACED' | 'RESET' | 'HISTORICAL' | 'ON_HOLD'
  document_intact?: boolean
  signatures?: SignatureVerificationResult[]
}

export const APPROVAL_STATE_LABELS = {
  CURRENT: 'Current approval', REPLACED: 'Replaced by a later signature',
  RESET: 'Approval reset; fresh approval required', HISTORICAL: 'Historical approval',
  ON_HOLD: 'QA review in progress; release authority on hold',
}

export function signatureIntegrityLabel(status: SignatureVerificationResult['status']) {
  switch (status) {
    case 'VALID': return 'Integrity verified'
    case 'LEGACY': return 'Older signature · no original seal'
    case 'UNVERIFIABLE': return 'Verification key unavailable'
    case 'TAMPERED': return 'Approval evidence changed'
    default: return 'Verification unavailable'
  }
}

export function verificationPresentation(result: SignatureVerificationResult, mode: 'pdf' | 'id') {
  const signatures = result.signatures || [result]
  if (result.status === 'TAMPERED' || signatures.some((signature) => signature.status === 'TAMPERED')) {
    return { tone: 'danger', title: 'Verification failed: changes detected' }
  }
  if (result.status === 'LEGACY') return { tone: 'warning', title: 'Older signature: no original integrity seal' }
  if (mode === 'pdf' && result.document_intact && signatures.some((signature) => signature.status === 'LEGACY')) {
    return { tone: 'warning', title: 'PDF unchanged; older signature unverified' }
  }
  if (mode === 'pdf' && result.document_intact && signatures.some((signature) => signature.status === 'UNVERIFIABLE')) {
    return { tone: 'warning', title: 'PDF unchanged; signature key unavailable' }
  }
  if (mode === 'pdf' && (result.document_intact !== true || !result.signatures?.length)) {
    return { tone: 'warning', title: 'PDF verification unavailable' }
  }
  if (result.status !== 'VALID') return { tone: 'warning', title: mode === 'pdf' ? 'PDF verification unavailable' : 'Signature verification unavailable' }
  if (signatures.some((signature) => signature.status !== 'VALID')) {
    return { tone: 'warning', title: 'Signature verification unavailable' }
  }
  if (signatures.some((signature) => signature.approval_state && signature.approval_state !== 'CURRENT')) {
    return { tone: 'warning', title: 'Integrity verified; approval is no longer current' }
  }
  return { tone: 'success', title: mode === 'pdf' ? 'PDF and signature integrity verified' : 'Signature integrity verified' }
}
