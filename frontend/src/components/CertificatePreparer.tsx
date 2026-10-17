import React from 'react'
import type { CertificatePreparer as PreparerIdentity } from '../types'
import { formatDateTimeIST } from '../time'

const ACCOUNT_TYPES = { BANK_STAFF: 'Bank Staff', VENDOR: 'Vendor', STANDARD: 'Standard account' }

export default function CertificatePreparer({ identity }: { identity?: PreparerIdentity | null }) {
  return <section className="certificate-preparer" aria-label="Certificate preparer">
    <div className="certificate-preparer-person">
      <span className="certificate-preparer-label">Prepared by</span>
      <strong>{identity?.full_name || 'Not recorded on this certificate'}</strong>
      {identity && <span className="certificate-preparer-username">@{identity.username}</span>}
      {identity?.user_type === 'VENDOR' && <span className="certificate-preparer-organization">{identity.vendor_organization_name || 'Organization not provided'}</span>}
      <small>{!identity ? 'Preparer details were not captured for this certificate.' : identity.is_frozen
        ? `Recorded at issuance${identity.captured_at ? ` · ${formatDateTimeIST(identity.captured_at)}` : ''}`
        : 'Current preparer; details are preserved when issued.'}</small>
    </div>
    {identity && <span className={`certificate-preparer-badge certificate-preparer-${identity.user_type.toLowerCase()}`}>{ACCOUNT_TYPES[identity.user_type]}</span>}
  </section>
}
