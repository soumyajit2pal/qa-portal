# Encrypted login payload deployment

The browser now sends encrypted JSON to POST /api/auth/login. It obtains a public RSA key and a signed two-minute challenge from GET /api/auth/login-key. It encrypts username/password using a fresh AES-256-GCM key and 12-byte random IV, binds the challenge as authenticated data, and wraps the AES key using RSA-OAEP with SHA-256. Only the backend private key decrypts the payload. Local and LDAP authentication still verify the original password server-side. Plaintext form and plaintext JSON requests are rejected; there is no fallback.

## Release setup

Admin user creation (`POST /api/auth/users`) and password reset
(`POST /api/auth/users/{id}/reset-password`) also require an `encrypted_password`
envelope using the same key endpoint and encryption format. Inside the envelope,
the username field binds the password to `create-user:<username>` or
`reset-password:<user-id>`. Each operation fetches a fresh, uncached challenge.
The backend checks this context, validates the decrypted password policy, and
stores only its bcrypt hash. LDAP user creation omits the password envelope.
Legacy `password` and `new_password` fields are rejected without echoing their
values in validation responses. Deploy the frontend and backend together;
restart direct backend processes and reload the browser after updating.

Before starting the updated backend, apply the Oracle migration from `backend/`
using the deployment's configured database connection: `alembic upgrade head`.
Revision `b72d91a0c483` adds `qap_used_login_challenges` and its expiry index.
All workers/replicas must share this database. Roll out all backend instances
together; older instances do not enforce single-use challenges. Missing table,
database outage, or failed replay-state commit blocks login with HTTP 503.

Revision `c83ea2b1d594` also adds `qap_login_failures` for shared sign-in
rate limits. Apply it with the same `alembic upgrade head` command before
deploying the backend, and rebuild the frontend for the recovery button.
Five failures for a username/IP pair within a rolling 15-minute window block
further attempts until enough failures expire. HTTP 429 now reports the
remaining minutes/seconds and includes `Retry-After` in seconds. Blocked
requests do not extend the waiting period.

Administrators can open a user's access/permissions dialog and click
**Unlock sign-in now** to clear that user's failures across every IP and
worker immediately. The operation records a `LOGIN_UNLOCK` audit event.
It does not change passwords, account activation, roles, or LDAP directory
lockouts, and normal limits apply again to subsequent failures. Rate-limit
database failures return 503 instead of bypassing enforcement. Coordinate
the rollout of all workers: older workers retain independent memory counters.

Rebuild/export/transfer BOTH backend and frontend images. Old frontend login clients are incompatible with the encrypted-only API. Existing bearer sessions do not change solely because of this payload change.

Create a separate private-key directory on the deployment PC. Keep it outside all uploads, Document Portal storage, web roots, and exported application bundles. In the following example replace RELEASE_TAG with the image tag that was loaded:

```sh
mkdir -m 700 secrets
podman run --rm --entrypoint python -v "$PWD/secrets:/keys:Z" qualityops-backend:RELEASE_TAG -m app.generate_login_key /keys/login-private.pem
```

The generator creates a 3072-bit RSA PKCS#8 PEM with file mode 0600 and refuses to overwrite an existing key. If the directory already exists, use it after checking its ownership/permissions instead of rerunning mkdir. Do not regenerate a live deployment's key accidentally.

The updated docker-compose.yml mounts ${LOGIN_ENCRYPTION_KEY_HOST_DIR:-./secrets} read-only at /run/secrets/qualityops in the backend container and sets LOGIN_ENCRYPTION_PRIVATE_KEY_FILE=/run/secrets/qualityops/login-private.pem. All backend workers/replicas must use the same key file. For a custom directory set LOGIN_ENCRYPTION_KEY_HOST_DIR in the Compose substitution environment. No private key is embedded in JavaScript or images.

For deployment without Compose, set LOGIN_ENCRYPTION_PRIVATE_KEY_FILE to a readable, privately protected RSA PEM path. UAT/production refuse to publish a public login key when that private key is not configured or unavailable (503). Development alone can generate a shared local key under backend/.secrets, which is excluded from source control.

Retain the trusted-proxy HTTPS setup described in PT_Remediation_2026-09-16.md. HTTPS is required for Web Crypto on real deployment hosts and authenticates the server public key. Plain HTTP localhost is only a development exception supported by browsers. Do not trust arbitrary forwarded headers or expose the backend port publicly.

## Verification

- GET /api/auth/login-key over HTTPS returns a public key/challenge with Cache-Control: no-store. It never returns the private key.
- POST /api/auth/login contains key_id, challenge, wrapped_key, iv and ciphertext; no username/password form values.
- A legitimate encrypted local or LDAP login succeeds according to the existing account checks.
- Plaintext form requests return 415. Plaintext JSON and tampered/expired envelopes return generic 400 errors without echoing credentials.
- Encrypting identical credentials again generates different IVs and ciphertext.
- Confirm all workers can decrypt requests generated from another worker's public-key response.
- Submit a valid envelope twice: only the first attempt reaches credential verification;
  subsequent submissions return HTTP 400, including across workers and restarts.
- Submit the same envelope concurrently: at most one request reaches authentication.
- After a failed password attempt, fetch a fresh challenge before retrying (the frontend already does this).

## Rotation and limits

Back up the key securely outside document exports. To rotate, generate a new private key separately, replace the mounted file in a coordinated maintenance window, and restart all backend replicas to clear their cached key. In-flight envelopes using the old key will fail and the user must retry with a fresh challenge.

This additional layer prevents readable passwords in the captured HTTP request body at TLS termination. It does not hide typed passwords from the user's browser, protect a compromised endpoint, or encrypt credentials inside the authentication server. Each challenge is now consumed once after authenticated decryption and before password verification, in an independent committed database transaction. The primary key on its signed JWT ID prevents reuse across workers and restarts, even if authentication fails. Only IDs and expiry timestamps are stored; entries expired for more than one day are removed during subsequent consumption. A captured unused envelope can still be raced against its legitimate submission: single-use enforcement allows at most one winner and does not authenticate which client sent it. TLS and secure session handling remain required. Never log decrypted credentials or request bodies.
