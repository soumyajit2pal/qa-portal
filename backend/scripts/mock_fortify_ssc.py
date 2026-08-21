#!/usr/bin/env python3
"""Mock Fortify SSC server -- for local testing of the SAST/DAST Start Scan /
Rescan / Mark Scan Complete flow without access to a real Fortify SSC
instance.

Implements exactly the endpoints app/fortify_ssc.py's FortifySSCClient calls
(see that file's retrieve_snapshot for the real sequence this mirrors):
    POST /api/v1/tokens
    GET  /api/v1/projects?count=-1
    GET  /api/v1/projects/{id}/versions?count=-1
    GET  /api/v1/projectVersions/{id}/filterSets
    GET  /api/v1/projectVersions/{id}/issueGroups?...

Uses only the standard library -- nothing to install.

Pre-seeded demo projects (type these exact Application Name / Application
Version values into the app's Start Scan / Rescan dialog):

    Demo Banking Portal   / 1.0         -- has findings; each Rescan against
                                            this same name+version roughly
                                            halves the finding count, so a
                                            few Rescans naturally reach 0.
    Demo Banking Portal   / 1.0-clean   -- always 0 findings, from the very
                                            first scan (fast path to test
                                            Mark Scan Complete / FR-06 rule 1
                                            without doing several Rescans).
    Payment Gateway API   / 2.3         -- second demo app, same
                                            findings-halve-on-rescan behaviour.

Any Application Name / Version NOT in that list (and not registered via
/mock/register below) behaves exactly like the real client's "not found"
path -- lets you see the app's own "was not found in Fortify SSC" error.

Register additional demo projects on the fly:
    curl -X POST http://127.0.0.1:8089/mock/register \\
      -d '{"application_name": "My Test App", "application_version": "1.0"}'

Inspect current state (finding counts, scan numbers) at any time:
    curl http://127.0.0.1:8089/mock/state

Usage:
    python3 backend/scripts/mock_fortify_ssc.py [--host 127.0.0.1] [--port 8089]

Then point the backend at it (backend/.env):
    FORTIFY_SSC_URL=http://127.0.0.1:8089
    FORTIFY_SSC_AUTH=bW9jazptb2Nr    # any base64 string -- not checked
    FORTIFY_SSC_VERIFY_TLS=false
"""
import argparse
import hashlib
import json
import re
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

_LOCK = threading.Lock()
_NEXT_ID = [1000]

# application_name -> {"id": int, "versions": {application_version: version_id}}
PROJECTS: dict = {}
# version_id -> {"name": str, "version": str, "scan_number": int, "current_total": int | None}
VERSION_STATE: dict = {}


def _next_id() -> int:
    _NEXT_ID[0] += 1
    return _NEXT_ID[0]


def register(name: str, version: str) -> tuple[int, int]:
    with _LOCK:
        project = PROJECTS.setdefault(name, {"id": _next_id(), "versions": {}})
        if version not in project["versions"]:
            vid = _next_id()
            project["versions"][version] = vid
            VERSION_STATE[vid] = {"name": name, "version": version, "scan_number": 0, "current_total": None}
        return project["id"], project["versions"][version]


def _seed_total(name: str, version: str) -> int:
    # Deterministic per name+version so re-running the mock server gives the
    # same starting finding count for the same demo app -- not a real
    # random source, just a stable spread between 8 and 25.
    digest = hashlib.sha1(f"{name}::{version}".encode()).hexdigest()
    return 8 + (int(digest[:4], 16) % 18)


def _advance_scan(vid: int) -> None:
    # Called once per retrieve_snapshot() invocation (at the filterSets
    # step, which the real client only hits once per Start Scan/Rescan) --
    # this is what makes each successive Rescan against the same
    # name+version show fewer findings than the last.
    with _LOCK:
        state = VERSION_STATE[vid]
        state["scan_number"] += 1
        if state["version"].endswith("-clean"):
            total = 0
        else:
            total = _seed_total(state["name"], state["version"])
            for _ in range(state["scan_number"] - 1):
                total //= 2
        state["current_total"] = total


def _severity_split(total: int) -> dict:
    if total <= 0:
        return {"Critical": 0, "High": 0, "Medium": 0, "Low": 0}
    weights = {"Critical": 0.15, "High": 0.25, "Medium": 0.25, "Low": 0.35}
    raw = {k: total * w for k, w in weights.items()}
    counts = {k: int(v) for k, v in raw.items()}
    remainder = total - sum(counts.values())
    order = sorted(weights, key=lambda k: raw[k] - counts[k], reverse=True)
    i = 0
    while remainder > 0:
        counts[order[i % len(order)]] += 1
        remainder -= 1
        i += 1
    return counts


def _filter_total(base_total: int, filterset: str) -> int:
    """Return a distinct mock count per filter without inventing findings.

    Quick View stays intentionally larger while findings exist, which helps
    catch accidental summing across overlapping filters. Once the mock scan
    has resolved to zero, every filter must also resolve to zero; the old
    ``base_total * 5 + 7`` formula left seven phantom Quick View findings
    forever and made the zero-result workflow impossible to test.
    """
    if base_total <= 0:
        return 0
    return base_total if filterset == "SECURITY_AUDITOR_VIEW" else base_total * 5 + 7


def _dump_state() -> dict:
    out = []
    for name, project in PROJECTS.items():
        for version, vid in project["versions"].items():
            state = VERSION_STATE[vid]
            out.append({
                "application_name": name,
                "application_version": version,
                "project_id": project["id"],
                "version_id": vid,
                "scan_number": state["scan_number"],
                "current_total": state["current_total"],
            })
    return {"projects": out}


class Handler(BaseHTTPRequestHandler):
    server_version = "MockFortifySSC/1.0"

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, text: str, status: int = 200) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        path = urlparse(self.path).path.rstrip("/")
        if path.endswith("/tokens"):
            # Real SSC issues a real token from Basic auth; this mock never
            # checks the Authorization header at all -- any FORTIFY_SSC_AUTH
            # value works, since the point is testing the app's own
            # workflow, not SSC's authentication.
            self._send_json({"data": {"token": str(uuid.uuid4())}})
            return
        if path == "/mock/register":
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                payload = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                self._send_json({"error": "invalid JSON body"}, 400)
                return
            name = str(payload.get("application_name", "")).strip()
            version = str(payload.get("application_version", "")).strip()
            if not name or not version:
                self._send_json({"error": "application_name and application_version are required"}, 400)
                return
            register(name, version)
            self._send_json({"status": "registered", "application_name": name, "application_version": version})
            return
        self._send_json({"error": "not found", "path": self.path}, 404)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "" or path == "/":
            self._send_text(
                "Mock Fortify SSC is running.\n\n"
                "Pre-seeded demo projects (type exactly into Start Scan / Rescan):\n"
                "  Demo Banking Portal / 1.0\n"
                "  Demo Banking Portal / 1.0-clean\n"
                "  Payment Gateway API / 2.3\n\n"
                "Register more:  POST /mock/register {application_name, application_version}\n"
                "Inspect state:  GET  /mock/state\n"
            )
            return

        if path == "/mock/state":
            self._send_json(_dump_state())
            return

        match = re.search(r"/api/v1/projects/(\d+)/versions$", path)
        if match:
            pid = int(match.group(1))
            project = next((p for p in PROJECTS.values() if p["id"] == pid), None)
            versions = [{"id": vid, "name": vname} for vname, vid in (project or {}).get("versions", {}).items()]
            self._send_json({"data": versions})
            return

        if path.endswith("/api/v1/projects"):
            data = [{"id": project["id"], "name": name} for name, project in PROJECTS.items()]
            self._send_json({"data": data})
            return

        match = re.search(r"/api/v1/projectVersions/(\d+)/filterSets$", path)
        if match:
            vid = int(match.group(1))
            if vid not in VERSION_STATE:
                self._send_json({"data": []})
                return
            _advance_scan(vid)
            # Two filter sets on purpose, like a real SSC instance --
            # "Quick View" deliberately returns a different (inflated) count
            # below than "Security Auditor View", so this mock can prove the
            # app never sums across filter sets (see the issueGroups branch)
            # and always reads counts from Security Auditor View alone.
            self._send_json({"data": [
                {"guid": "SECURITY_AUDITOR_VIEW", "title": "Security Auditor View"},
                {"guid": "QUICK_VIEW", "title": "Quick View"},
            ]})
            return

        match = re.search(r"/api/v1/projectVersions/(\d+)/issueGroups$", path)
        if match:
            vid = int(match.group(1))
            state = VERSION_STATE.get(vid)
            base_total = (state or {}).get("current_total") or 0
            filterset = (parse_qs(parsed.query).get("filterset") or [""])[0]
            # Quick View deliberately differs while findings exist, but it
            # must reach zero on the same scan as Security Auditor View so
            # the portal's all-current-filters-zero completion gate can pass.
            total = _filter_total(base_total, filterset)
            counts = _severity_split(total)
            self._send_json({"data": [{"id": severity, "totalCount": count} for severity, count in counts.items()]})
            return

        self._send_json({"error": "not found", "path": self.path}, 404)

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 -- BaseHTTPRequestHandler signature
        print(f"[mock-fortify-ssc] {self.address_string()} - {fmt % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8089)
    args = parser.parse_args()

    register("Demo Banking Portal", "1.0")
    register("Demo Banking Portal", "1.0-clean")
    register("Payment Gateway API", "2.3")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Mock Fortify SSC listening on http://{args.host}:{args.port}")
    print("Pre-seeded demo projects:")
    print("  Demo Banking Portal / 1.0        (has findings, halves each rescan)")
    print("  Demo Banking Portal / 1.0-clean  (always 0 findings)")
    print("  Payment Gateway API / 2.3        (has findings, halves each rescan)")
    print(f"Register more: curl -X POST http://{args.host}:{args.port}/mock/register "
          "-d '{\"application_name\": \"X\", \"application_version\": \"Y\"}'")
    print("Point the backend at it via backend/.env -- see this file's module docstring.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
