# QualityOps penetration-test remediation

Source: Quality Ops PT.xlsx, Quality Ops worksheet, findings 1–5. This records code changes and verification, not acceptance by the penetration-test team.

## 1. Response manipulation and vertical privilege escalation

The current backend verifies HS256 JWT signatures with issuer/audience checks, resolves the subject to an active database user, and uses current database roles for authorization. The frontend loads /api/auth/me after login. Changing response display roles cannot grant backend access.

JWT decoding now requires sub, exp, iat, jti, iss and aud, and rejects empty/invalid subject types. Tests prove modified signatures are rejected and even a correctly signed requester token with an ADMIN role claim still resolves to the requester with REQUESTER permissions. Administrative role checks deny that user. Deactivated users cannot reuse a token.

The reported /me response becoming a different admin account could not be reproduced from role modification against this source. Retest with the same requester token before and after modification, record HTTP requests/statuses, and ensure no previously captured administrator token is substituted. A stolen valid admin token is an admin credential and must be revoked through key rotation/account recovery.

## 2. User update parameter tampering

UserUpdate now forbids unknown parameters and no longer accepts full_name. username, IDs, password hashes, relationships, name and unexpected attributes are rejected with validation errors before update logic. Access-management fields remain permitted for System Administrators. Coordinators retain their narrower existing schema and scoped authorization.

Tests cover the protected-field payloads and a valid access-management payload. The endpoint already requires ADMIN server-side. User creation still accepts identity fields as needed for provisioning; this is a separate authorized operation.

## 3. Credentials and transport security

Both deployed API services now reject non-HTTPS application requests in UAT/production with 426, before authentication/database work. Only /api/health is exempt for private container health probes. Development remains usable over HTTP. Production frontend refuses to submit login credentials from an HTTP page.

The scheme comes from ASGI/Uvicorn trusted-proxy processing, never direct trust of an X-Forwarded-Proto header. A test proves a forged header alone cannot bypass the guard. Nginx terminates TLS 1.2/1.3 and overwrites forwarded scheme headers. HTTPS prevents cleartext transmission on the network; a debugging proxy that decrypts trusted TLS or the browser itself can still display form values. The login payload now has additional RSA-OAEP/SHA-256 and AES-256-GCM public-key encryption. Plaintext forms/JSON are rejected. TLS remains mandatory. See Login_Encryption_Deployment.md for key setup and retesting.

### Deployment required

Rebuild and transfer backend AND frontend images. Both backend and document_portal must have FORWARDED_ALLOW_IPS set to the actual trusted nginx proxy IP(s), in the environment file loaded by Compose. Uvicorn already enables proxy-header processing by default. Do not set a wildcard on a network where untrusted clients can contact the API containers. Keep backend/document_portal ports private and expose only the nginx TLS listener. Use stable proxy addresses or a properly restricted network allowlist supported by the installed Uvicorn release.

Without that proxy allowlist, HTTPS terminated at nginx is seen as HTTP internally and requests intentionally fail with 426. Confirm the deployed trusted-proxy path before enabling the release.

Use a trusted certificate with the correct hostname. Rotate the administrator password disclosed in the PT evidence and rotate the JWT SECRET_KEY on both API services together to invalidate previously captured tokens. Users must sign in again. Do not put credentials, authentication request bodies or Authorization headers in proxy/application tracing logs.

Retest: HTTP login must not authenticate, HTTPS login must work, requester privileged API calls must return 403, and /api/health must remain healthy privately.

## 4. API paths visible in JavaScript

Production Vite builds explicitly disable source maps and minify code. Nginx rejects .map requests and dotfile/repository metadata paths. The isolated Document Portal now disables Swagger, ReDoc and OpenAPI routes in UAT/production, matching the core API.

Browser-consumed API paths remain visible by design. Hiding these paths is not an authorization control. This finding requires the test team to distinguish necessary client routing from a demonstrated unprotected API. Current server-side authorization and deployment controls remain the primary protection. No endpoint renaming or obfuscation is used as a substitute.

## 5. CSP inline styles

Both nginx configurations explicitly disallow script attributes, permit scripts only from self, and disallow inline style blocks with style-src-elem 'self'. The generic style-src no longer contains unsafe-inline.

style-src-attr 'unsafe-inline' remains explicitly permitted for existing rich-text style attributes and dynamic presentation. This is a remaining defense-in-depth exception; it does not allow inline JavaScript. Full removal is not claimed. Removing it requires migrating persisted rich-text formatting and verifying all presentation dependencies, rather than silently breaking those features. The report's quoted policy already blocked inline scripts; its observed unsafe-inline directive concerned styles.

## Verification

Backend regression: 514 tests and 79 subtests passed, including new tampered-token, database-role, schema-allowlist and HTTPS-spoofing checks. Frontend production compilation passed. This task did not contact the PT server, change remote infrastructure, send mail, or verify the deployed proxy/certificate headers. Findings 1, 3, 4 and the remaining style exception need the described deployment/PT retest before closure.

## Reference standards

- https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src-attr
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy
