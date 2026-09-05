# VA/PT Readiness Review

Review date: 5 September 2026

## Scope

Static review and hardening covered the React frontend, FastAPI APIs, authentication, LDAP and Fortify integrations, department and project authorization, uploads/downloads, storage paths, reverse-proxy configuration, container images, secrets, and direct dependencies. This review does not replace authenticated DAST, infrastructure scanning, or a manual penetration test against the deployed environment.

## Remediated findings

| Severity | Finding | Resolution |
|---|---|---|
| Critical | `python-jose` 3.3.0 was affected by an algorithm-confusion vulnerability | Upgraded to 3.5.0; JWT verification remains restricted to HS256 and now validates issuer and audience. |
| Critical | Direct IDs could bypass department/project list scope and expose request details, history, exports, evidence, comments, defects, test cases, cycles, execution runs, and downloads | Added direct-record authorization to QA Request, Functional, SAST, DAST, Performance, Suppression, Sign-off, Defects, approval comments, and Test Management routes. |
| Critical | A scoped account with no department received unrestricted scope | Empty department mappings now fail closed and return no department-owned records. |
| Critical | Fortify SSC TLS verification was disabled in UAT | Enabled verification and added a runtime guard that rejects disabled verification outside development. |
| High | LDAP configuration contained credential defaults; TLS parsing was reversed; usernames entered the search filter unescaped | Removed credential defaults, corrected TLS handling, require secure LDAP outside development, and escape LDAP filter/DN values. |
| High | `python-multipart` 0.0.9 was behind multiple multipart denial-of-service fixes | Upgraded to 0.0.32. |
| High | Wildcard CORS and unrestricted methods/headers | CORS is now disabled for same-origin deployments unless explicit origins are configured; methods and headers are allow-listed. |
| High | Login endpoint had no brute-force boundary | Added a five-failure, fifteen-minute limiter per source address and username, with `429` and `Retry-After`. |
| High | bcrypt silently truncated passwords after 72 bytes | Over-length values are rejected; local passwords require at least 12 characters; malformed hashes fail safely. |
| High | Upload paths trusted stored relative paths | Resolved paths must remain below the configured upload root. |
| High | Shared uploads accepted executable/active web content and spoofed extensions | Added an extension allow-list, signature checks, batch limits, and a 25 MB general-document limit. QA Attach Evidence remains 10 MB per file as specified. |
| High | Backup deployment files contained fallback credentials and the demo seed used a known shared password | Removed Compose credential defaults, sanitized the backup profile, rotated the JWT key, restricted environment-file permissions to `0600`, and require an explicit demo seed password. |
| Medium | API documentation was exposed in UAT/production and defensive browser headers were incomplete | Disabled OpenAPI/Swagger/ReDoc outside development; added HSTS, CSP, anti-framing, MIME-sniffing, referrer and permissions policies. |
| Medium | Browser bearer token persisted beyond the browser session | Moved it from local storage to session storage and reduced the UAT token lifetime to 30 minutes. |
| Medium | Frontend builds were not reproducible and used end-of-life Node 20 / old Nginx 1.27 | Added a lockfile with `npm ci`, moved to Node 24 LTS and Nginx 1.28.3 stable. |

## Verification completed

- Python compilation completed for the backend and every router.
- Backend suite: **90 tests passed**.
- Frontend TypeScript and production build completed.
- Frontend production dependency audit: **0 vulnerabilities**.
- Static searches found no application raw-SQL interpolation, shell execution, unsafe dynamic evaluation, or unescaped rich-text rendering path.

## Required before the external test

1. Rotate the Oracle account password and any LDAP/Fortify credentials that were ever reused from local files or earlier source copies. Update the deployment secret store afterward. The JWT signing key has already been rotated locally.
2. Rebuild and redeploy both images so the Python dependency and base-image upgrades are present. Existing sessions will be invalid after the JWT rotation.
3. Confirm the Fortify/LDAP certificate chains are trusted by the containers; do not disable certificate validation to work around a private CA.
4. Run authenticated scans with at least these accounts: Requester in Department A, Requester in Department B, department approver, QA Engineer, Security Analyst, view-only user, and Administrator. Attempt cross-department numeric-ID substitution on every detail/export/download route.
5. Add malware scanning or quarantine for uploaded documents if the organization requires content inspection. The application now checks type and signature but is not an antivirus engine.
6. Apply an edge/WAF rate limit shared across all API workers. The application login limiter is intentionally local to each worker and is a second layer, not a substitute for an edge control.
7. Validate the deployed TLS configuration, certificate name, cipher policy, Oracle transport encryption, container image CVEs, and host patch level. These cannot be established from source code alone.

