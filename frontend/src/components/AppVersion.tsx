import frontendPackage from '../../package.json'

/** Display the release version from the package that produced this frontend. */
export default function AppVersion() {
  return <span className="app-version-label">App v{frontendPackage.version}</span>
}
