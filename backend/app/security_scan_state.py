"""Resolve current findings without inventing scans for unchanged targets."""


def _target_ids(row) -> set:
    return {target["id"] for target in (getattr(row, "targets", None) or [])
            if isinstance(target, dict) and target.get("id") is not None}


def current_scan_results(results) -> list:
    """Return the latest recorded result per target, from newest-first rows.

    Legacy executions without target identities remain indivisible. SAST
    uses attributable repository evidence when available, matching its
    coverage resolver; unattributed rows stay in history and are never
    added to repository counts. DAST retains its execution-based fallback.
    """
    selected = []
    seen = set()
    attributed_sast = any(getattr(row, "request_type", None) == "SAST" and _target_ids(row) for row in results)
    for row in results:
        identities = _target_ids(row)
        if not identities:
            if attributed_sast:
                continue
            if selected:
                break
            key = row.execution_key or f"legacy-{row.id}"
            return [result for result in results if (result.execution_key or f"legacy-{result.id}") == key]
        if identities - seen:
            selected.append(row)
            seen.update(identities)
    return selected


def initial_repository_results(results) -> list:
    """First attributable result per repository from oldest-first history.

    An old aggregate scan cannot establish a repository's initial findings.
    Keep the first legacy execution only when no target-specific evidence
    exists, preserving the historical all-legacy display.
    """
    selected, seen = [], set()
    for row in results:
        identities = _target_ids(row)
        if identities - seen:
            selected.append(row)
            seen.update(identities)
    if selected or not results:
        return selected
    key = results[0].execution_key or f"legacy-{results[0].id}"
    return [row for row in results if (row.execution_key or f"legacy-{row.id}") == key]


def scan_open_count(result) -> int:
    """Fortify filters overlap; require every view to be zero without summing."""
    totals = [int(result.total_count or 0)]
    for view in result.filters:
        try:
            totals.append(int(view.get("total_count") or 0))
        except (AttributeError, TypeError, ValueError):
            continue
    return max(totals, default=0)


def _identity(value):
    return str(value or "").strip()


def repository_states(obj, results) -> list[dict]:
    """Resolve SAST coverage against current repository, branch and commit.

    Results are immutable and newest first. A zero legacy scan without a
    structured code identity or a recorded validation never clears scope.
    """
    latest = {}
    for result in results:
        for snapshot in result.targets:
            if isinstance(snapshot, dict) and snapshot.get("id") not in latest:
                latest[snapshot.get("id")] = (result, snapshot)
    states = []
    for component in obj.components:
        recorded = latest.get(component.id)
        result, snapshot = recorded if recorded else (None, {})
        open_count = scan_open_count(result) if result else 0
        state = "NOT_SCANNED"
        if result:
            indexed = getattr(component, "latest_scan_id", None) == result.id
            identity_matches = all(_identity(getattr(component, field)) for field in ("repository_url", "git_branch", "commit_id")) and all(
                field in snapshot and _identity(snapshot[field]) == _identity(getattr(component, field))
                for field in ("repository_url", "git_branch", "commit_id")
            )
            validated = getattr(component, "validation_scan_id", None) == result.id
            stored_state = getattr(component, "scan_state", None)
            state = "STALE"
            # A submitted fix intentionally changes the commit after its old
            # scan; the queue remains ready until a fresh result is retrieved.
            if indexed and stored_state == "READY_FOR_RESCAN":
                state = "READY_FOR_RESCAN"
            elif indexed and identity_matches:
                if stored_state == "AWAITING_VALIDATION":
                    state = "AWAITING_VALIDATION"
                elif validated and stored_state == "CLEAR" and open_count == 0:
                    state = "CLEAR"
                elif validated and stored_state == "WAITING_FOR_FIX" and open_count > 0:
                    state = "WAITING_FOR_FIX"
        states.append({
            "target_id": component.id, "label": component.repository_url or "",
            "state": state, "commit_id": component.commit_id, "git_branch": component.git_branch,
            "latest_scan_id": result.id if result else None, "open_findings": open_count,
            "fix_submitted_at": getattr(component, "fix_submitted_at", None),
            "fix_submitted_by_id": getattr(component, "fix_submitted_by_id", None),
        })
    return states


def all_repositories_clear(obj, results) -> bool:
    states = repository_states(obj, results)
    return bool(states) and all(row["state"] == "CLEAR" for row in states)
