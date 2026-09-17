# Deployment recovery: Oracle migration and Redis

The supplied log contains two separate failures.

## Oracle ORA-02299

Revision 8c6f0a1b2d43 attempts uniqueness on (project_id, import_fingerprint). Oracle also rejects repeated partially NULL composite keys, so setting historical duplicate fingerprints to NULL did not solve this. Manual testcases also need to retain NULL fingerprints.

The corrected migration uses a conditional unique index: both expressions evaluate to NULL for non-imported/legacy rows. Non-NULL fingerprints remain unique per project. Duplicate imported rows are retained; the earliest keeps the cached fingerprint and later duplicates have only that cache cleared. Application import checks still derive legacy fingerprints from their definitions.

The release includes a follow-up migration d63b9f2a8e41 for databases already beyond the original revision. No testcase rows are deleted. Do not stamp past the failing migration.

On the deployment PC:

1. Stop application writers and take an Oracle backup.
2. Rebuild/export the backend image from this updated source on the build PC; transfer and load it on the deployment PC. Use a new IMAGE_TAG so the old image cannot be reused accidentally. Migrate, backend and document_portal must use that same tag.
3. Run the existing deployment migration service with your production environment file, then confirm Alembic current equals d63b9f2a8e41 before starting application services.

From the release directory, using the same compose project and deployment environment as the original launch:

```sh
podman-compose --env-file .env.prod run --rm migrate
podman-compose --env-file .env.prod run --rm migrate alembic current
```

If your compose provider is `podman compose`, use that provider consistently instead. Adjust the environment filename if the deployment uses a different name. The first command must succeed before proceeding.

## Redis crun exec.fifo missing

This error occurs before Redis starts and concerns the host's rootless Podman runtime state, not SMTP or Oracle. The log alone does not establish why that runtime file disappeared.

Run diagnostics as the original deployment user (UID 1013 in the log), not through sudo:

```sh
id
printf '%s\n' "$XDG_RUNTIME_DIR"
podman info --debug
podman ps -a
podman-compose --env-file .env.prod logs redis
```

After recording diagnostics, recreate only the Redis service container:

```sh
podman-compose --env-file .env.prod stop redis
podman-compose --env-file .env.prod rm -f redis
podman-compose --env-file .env.prod up -d redis
podman-compose --env-file .env.prod exec redis redis-cli ping
```

Expected response: PONG. Container removal above does not request volume deletion. Do not use `down -v`, `system reset`, or remove repository volumes. If recreation still fails, investigate the user's login/runtime directory, crun/Podman versions and host logs with the server administrator before changing runtime settings.

## Validation limits

The fixes are in the local source. The remote Oracle migration and Redis recovery must still be run and verified on the deployment PC; no access to that PC was available in this task.
