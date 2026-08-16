"""Minimal, server-side Fortify SSC result importer for SAST and DAST.

Credentials are read only from environment variables; browser clients never
receive them. The supplied reference scripts query projectVersions,
filterSets and issueGroups, which retrieves an existing SSC analysis rather
than starting an SCA/WebInspect engine job. This adapter intentionally keeps
that exact semantic and returns a normalized severity snapshot.
"""
import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Optional


class FortifySSCError(Exception):
    pass


@dataclass(frozen=True)
class FortifyScanSnapshot:
    application_name: str
    application_version: str
    project_version_id: str
    critical_count: int
    high_count: int
    medium_count: int
    low_count: int
    total_count: int
    audit_url: str
    filters: list[dict]


class FortifySSCClient:
    def __init__(self, kind: str):
        prefix = f"FORTIFY_SSC_{kind.upper()}"
        self.base_url = (os.getenv(f"{prefix}_URL") or os.getenv("FORTIFY_SSC_URL") or "").rstrip("/")
        self.basic_auth = os.getenv(f"{prefix}_AUTH") or os.getenv("FORTIFY_SSC_AUTH") or ""
        self.timeout = float(os.getenv("FORTIFY_SSC_TIMEOUT_SECONDS", "25"))
        self.verify_tls = os.getenv("FORTIFY_SSC_VERIFY_TLS", "true").strip().lower() not in ("0", "false", "no")
        if not self.base_url or not self.basic_auth:
            raise FortifySSCError(
                f"Fortify SSC is not configured for {kind.upper()}. Set {prefix}_URL/{prefix}_AUTH "
                "or the shared FORTIFY_SSC_URL/FORTIFY_SSC_AUTH environment variables."
            )
        self.api_url = f"{self.base_url}/api/v1"
        self._token: Optional[str] = None

    def _request(self, method: str, path: str, *, auth: Optional[str] = None, payload=None) -> dict:
        url = f"{self.api_url}/{path.lstrip('/')}"
        headers = {"Accept": "application/json"}
        if auth:
            headers["Authorization"] = auth
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload).encode("utf-8")
        else:
            body = None
        context = None if self.verify_tls else ssl._create_unverified_context()
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout, context=context) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise FortifySSCError(f"Fortify SSC returned HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise FortifySSCError(f"Unable to read Fortify SSC: {exc}") from exc

    def _access_token(self) -> str:
        if self._token:
            return self._token
        response = self._request(
            "POST", "tokens", auth=f"Basic {self.basic_auth}",
            payload={"description": "QualityOps scan result import", "type": "UnifiedLoginToken"},
        )
        token = (response.get("data") or {}).get("token")
        if not token:
            raise FortifySSCError("Fortify SSC did not return an access token")
        self._token = token
        return token

    def _get(self, path: str) -> dict:
        return self._request("GET", path, auth=f"FortifyToken {self._access_token()}")

    def retrieve_snapshot(self, application_name: str, application_version: str) -> FortifyScanSnapshot:
        versions = (self._get("projectVersions").get("data") or [])
        project_version = next((
            row for row in versions
            if str(row.get("name", "")).strip() == application_version
            and str((row.get("project") or {}).get("name", "")).strip().casefold() == application_name.casefold()
        ), None)
        if not project_version:
            raise FortifySSCError(
                f"Application '{application_name}' version '{application_version}' was not found in Fortify SSC"
            )
        version_id = str(project_version["id"])
        filter_sets = self._get(f"projectVersions/{version_id}/filterSets").get("data") or []
        filter_results = []
        aggregate = {"Critical": 0, "High": 0, "Medium": 0, "Low": 0}
        for filter_set in filter_sets:
            guid = str(filter_set.get("guid") or "")
            if not guid:
                continue
            query = urllib.parse.urlencode({
                "qm": "issues", "filterset": guid, "showhidden": "false",
                "showremoved": "false", "showsuppressed": "false",
                "showshortfilenames": "true", "groupingtype": "FOLDER",
            })
            result = self._get(f"projectVersions/{version_id}/issueGroups?{query}")
            severity_counts = {
                severity: next((int(item.get("totalCount") or 0) for item in result.get("data", []) if item.get("id") == severity), 0)
                for severity in aggregate
            }
            for severity, count in severity_counts.items():
                aggregate[severity] += count
            filter_results.append({
                "title": str(filter_set.get("title") or "Unnamed filter"),
                "guid": guid,
                "total_count": sum(severity_counts.values()),
                **{f"{severity.lower()}_count": count for severity, count in severity_counts.items()},
                "audit_url": f"{self.base_url}/html/ssc/version/{version_id}/audit?filterset={urllib.parse.quote(guid)}&orderby=friority&viewTab=code",
            })
        total = sum(aggregate.values())
        return FortifyScanSnapshot(
            application_name=application_name, application_version=application_version,
            project_version_id=version_id, critical_count=aggregate["Critical"], high_count=aggregate["High"],
            medium_count=aggregate["Medium"], low_count=aggregate["Low"], total_count=total,
            audit_url=f"{self.base_url}/html/ssc/version/{version_id}/audit",
            filters=filter_results,
        )
