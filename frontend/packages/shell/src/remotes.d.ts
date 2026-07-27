// Ambient module declarations for the 4 Module Federation remotes consumed
// in App.tsx. These specifiers (e.g. "functional/Functional") aren't real
// files anywhere in this repo -- @originjs/vite-plugin-federation resolves
// them at build/runtime to a real URL via the `remotes` map in
// vite.config.ts, pointing at each module's own independently-deployed
// remoteEntry.js. TypeScript has no way to know that, so without this file
// every `import('functional/Functional')` in App.tsx would fail to compile.
//
// Each declared module's shape must match what that remote's own
// vite.config.ts `exposes` map actually exports (a default-exported React
// component, same as every page component elsewhere in this app) -- see
// packages/functional/vite.config.ts etc.

declare module 'functional/Functional' {
  import type { ComponentType } from 'react'
  const Functional: ComponentType
  export default Functional
}

declare module 'security/SAST' {
  import type { ComponentType } from 'react'
  const SAST: ComponentType
  export default SAST
}

declare module 'security/DAST' {
  import type { ComponentType } from 'react'
  const DAST: ComponentType
  export default DAST
}

declare module 'security/Suppression' {
  import type { ComponentType } from 'react'
  const Suppression: ComponentType
  export default Suppression
}

declare module 'specialisedTesting/Automation' {
  import type { ComponentType } from 'react'
  const Automation: ComponentType
  export default Automation
}

declare module 'specialisedTesting/Performance' {
  import type { ComponentType } from 'react'
  const Performance: ComponentType
  export default Performance
}

declare module 'governance/SignOff' {
  import type { ComponentType } from 'react'
  const SignOff: ComponentType
  export default SignOff
}

declare module 'governance/Approvals' {
  import type { ComponentType } from 'react'
  const Approvals: ComponentType
  export default Approvals
}

declare module 'governance/Reports' {
  import type { ComponentType } from 'react'
  const Reports: ComponentType
  export default Reports
}

declare module 'governance/Admin' {
  import type { ComponentType } from 'react'
  const Admin: ComponentType
  export default Admin
}
