"""Minimal, server-side Fortify SSC result importer for SAST and DAST.

Credentials are read only from environment variables; browser clients never
receive them. The confirmed-working lookup (2026-08 reference trace against
the live SSC instance) is a project-scoped chain, not a single flat query:
GET projects (match by application name -> project id), then
GET projects/{id}/versions (match by version name -> project version id),
then projectVersions/{id}/filterSets and issueGroups per filter set for the
actual severity counts -- see retrieve_snapshot for why each filter set's
counts are kept independent (never summed together into one number) and
which single filter set ("Security Auditor View") drives gating decisions
like Mark Scan Complete. This retrieves an existing SSC analysis rather than
starting an SCA/WebInspect engine job -- this adapter intentionally keeps
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
        projects = (self._get("projects?count=-1").get("data") or [])
        project = next((
            row for row in projects
            if str(row.get("name", "")).strip().casefold() == application_name.strip().casefold()
        ), None)
        if not project:
            raise FortifySSCError(f"Application '{application_name}' was not found in Fortify SSC")
        project_id = project["id"]
        versions = (self._get(f"projects/{project_id}/versions?count=-1").get("data") or [])
        project_version = next((
            row for row in versions
            if str(row.get("name", "")).strip() == application_version
        ), None)
        if not project_version:
            raise FortifySSCError(
                f"Application '{application_name}' version '{application_version}' was not found in Fortify SSC"
            )
        version_id = str(project_version["id"])
        filter_sets = self._get(f"projectVersions/{version_id}/filterSets").get("data") or []
        if not filter_sets:
            raise FortifySSCError(
                f"No filter sets found for '{application_name}' version '{application_version}' in Fortify SSC"
            )
        # 2026-08 -- reported directly: "sum of filter in total is wrong" --
        # each filter set SSC returns is a different LENS over the same
        # underlying issues (Security Auditor View, Quick View, OWASP Top
        # 10, PCI-DSS 3.2, etc all cover overlapping issues, just grouped/
        # labelled differently), so summing every filter set's counts
        # together double- and triple-counts the same findings under every
        # view they happen to also appear in. Fixed by never adding filter
        # sets together: each one keeps its own independent Critical/High/
        # Medium/Low/Total below (see filter_results), and the UI shows
        # them "split by filter" (each with its own individual total, not
        # combined) rather than as one number.
        filter_results = []
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
                for severity in ("Critical", "High", "Medium", "Low")
            }
            filter_results.append({
                "title": str(filter_set.get("title") or "Unnamed filter"),
                "guid": guid,
                "total_count": sum(severity_counts.values()),
                **{f"{severity.lower()}_count": count for severity, count in severity_counts.items()},
                "audit_url": f"{self.base_url}/html/ssc/version/{version_id}/audit?filterset={urllib.parse.quote(guid)}&orderby=friority&viewTab=code",
            })
        if not filter_results:
            raise FortifySSCError(
                f"No usable filter sets found for '{application_name}' version '{application_version}' in Fortify SSC"
            )
        # The top-level critical/high/medium/low/total fields (used for
        # gating decisions -- Mark Scan Complete's FR-06 rules, "does this
        # scan have open findings" -- not for display) need exactly ONE
        # filter set as their source, never several combined. "Security
        # Auditor View" is SSC's standard comprehensive view; fall back to
        # whichever filter set SSC returned first if that exact name isn't
        # present (naming can vary slightly across SSC instances/versions).
        primary = next(
            (f for f in filter_results if "security auditor view" in f["title"].strip().casefold()),
            filter_results[0],
        )
        return FortifyScanSnapshot(
            application_name=application_name, application_version=application_version,
            project_version_id=version_id,
            critical_count=primary["critical_count"], high_count=primary["high_count"],
            medium_count=primary["medium_count"], low_count=primary["low_count"], total_count=primary["total_count"],
            audit_url=f"{self.base_url}/html/ssc/version/{version_id}/audit",
            filters=filter_results,
        )
