// Dynamic import (not `import './bootstrap'` statically) is required here --
// see the comment at the top of bootstrap.tsx for why: Module Federation
// needs this async boundary before any shared-dependency-touching code runs.
import('./bootstrap')
