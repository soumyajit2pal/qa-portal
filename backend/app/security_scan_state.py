"""Resolve current findings without inventing scans for unchanged targets."""


def current_scan_results(results) -> list:
    """Return the latest recorded result per target, from newest-first rows.

    Legacy executions without target identities remain indivisible. They
    cannot safely be attributed to a modern URL or combined with its counts.
    """
    selected = []
    seen = set()
    for row in results:
        targets = getattr(row, "targets", None) or []
        identities = {target["id"] for target in targets if target.get("id") is not None}
        if not identities:
            if selected:
                break
            key = row.execution_key or f"legacy-{row.id}"
            return [result for result in results if (result.execution_key or f"legacy-{result.id}") == key]
        if identities - seen:
            selected.append(row)
            seen.update(identities)
    return selected
