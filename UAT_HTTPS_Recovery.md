# UAT 426 Upgrade Required

426 on /api/auth/login-key means the API sees HTTP. The loopback address in the supplied log is compatible with a local proxy or a direct call; it does not establish whether the browser used HTTPS. The API must not accept a client-supplied forwarded header without a trusted proxy.

## Local Vite and Uvicorn UAT

Use a trusted TLS certificate whose subject alternative names include the hostname opened in the browser. The existing deployment certificate may be used if it covers that hostname.

From backend:

```sh
APP_ENV=uat uvicorn app.main:app --port 8000 --proxy-headers --forwarded-allow-ips=127.0.0.1
```

This listens on loopback, behind Vite. Use the existing TLS_CERT_HOST_PATH in the repository-root .env.uat (or override it in frontend/.env.uat or the process environment):

```dotenv
TLS_CERT_HOST_PATH=./certs/
VITE_BACKEND_URL=http://127.0.0.1:8000
```

The directory must contain qualityops.crt and qualityops.key, matching Compose/nginx. Relative paths resolve from the repository root. Certificates are loaded for Vite dev/preview only; builds do not require them.

Then run from frontend:

```sh
npm run dev -- --mode uat
```

Open https://localhost:5173 (or the certificate's actual hostname). Do not open http://localhost:5173 or the private upstream http://localhost:8000. Vite now overwrites X-Forwarded-Proto using the actual TLS socket. Uvicorn accepts it only from loopback in the example above.

The encrypted login key is also required in UAT: configure LOGIN_ENCRYPTION_PRIVATE_KEY_FILE in backend/.env.uat to the privately protected PEM generated according to Login_Encryption_Deployment.md. Otherwise transport recovery will reveal a separate 503 key-configuration error. Do not put this private RSA key in frontend settings; frontend needs only the TLS server certificate and its matching TLS key for the HTTPS listener.

## Podman/Docker with nginx

Open nginx's HTTPS portal URL, not the backend container port. Nginx already overwrites X-Forwarded-Proto with its HTTPS scheme. Set FORWARDED_ALLOW_IPS to the actual nginx container/proxy IP in the environment loaded by BOTH backend and document_portal, then recreate those services to pick it up. Each service must trust only the ingress proxy addresses that can reach its private listener. Do not blindly use *.

A 426 after an HTTPS browser request means trusted-proxy recognition is absent or wrong. Identify the nginx peer address from the container network, set the correct allowlist and restart; do not disable the HTTPS guard. Do not manually fake the scheme for an HTTP browser request.

## Direct API TLS

For an API served directly without a TLS proxy, Uvicorn supports --ssl-certfile and --ssl-keyfile. Use the trusted certificate/key and open the matching HTTPS URL. Keep production behind its normal private ingress design.

## Checks

- HTTPS /api/auth/login-key succeeds when the private login key is configured.
- Genuine HTTP /api/auth/login-key remains 426 in UAT.
- An untrusted client's forged X-Forwarded-Proto header remains rejected.
- HTTPS encrypted login works and local/LDAP authentication retains its normal checks.


## Confirmed local UAT correction

Vite now reads HTTPS/backend settings from frontend/.env.uat with project-root .env.uat fallback. The missing root-profile fallback previously started an HTTP frontend despite certificate settings. Port 5173 is strict so a second frontend cannot silently start on another port.

The local certs/qualityops.crt was missing Subject Alternative Names. scripts/generate-local-uat-tls.py now generates a localhost/127.0.0.1/::1 SAN leaf certificate signed by a project-local CA, preserving replaced files under certs/backup-*. The private keys remain outside source control. The script requires Python cryptography and does not automatically install trust.

The project-root .env.uat now references the existing 3072-bit backend/login-private.pem. Restart both processes after certificate/profile changes. Verified locally: HTTPS login-key endpoint returns 200 with the generated CA supplied for certificate validation. macOS Keychain trust installation was declined; manually import certs/qualityops-uat-ca.crt in the login keychain, set its certificate trust to Always Trust, and restart the browser. Import only the CA certificate, never its private key. Use https://localhost:5173; access by another network hostname/IP requires that name/IP in the certificate SAN.
