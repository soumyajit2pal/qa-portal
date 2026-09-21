import ipaddress
from starlette.requests import Request
from app import audit_service


def request(peer, forwarded='', real_ip=''):
    headers = []
    if forwarded:
        headers.append((b'x-forwarded-for', forwarded.encode()))
    if real_ip:
        headers.append((b'x-real-ip', real_ip.encode()))
    return Request({'type': 'http', 'client': (peer, 1234) if peer is not None else (None, 0), 'headers': headers})


def test_trusted_local_proxy_records_browser_ip(monkeypatch):
    monkeypatch.setattr(audit_service, 'TRUSTED_PROXY_NETWORKS', (ipaddress.ip_network('127.0.0.1/32'),))
    assert audit_service.request_ip(request('127.0.0.1', '192.168.10.25')) == '192.168.10.25'


def test_untrusted_client_cannot_forge_source_ip(monkeypatch):
    monkeypatch.setattr(audit_service, 'TRUSTED_PROXY_NETWORKS', (ipaddress.ip_network('127.0.0.1/32'),))
    assert audit_service.request_ip(request('192.168.10.25', '1.2.3.4')) == '192.168.10.25'


def test_proxy_normalized_missing_peer_uses_nginx_real_ip(monkeypatch):
    monkeypatch.setattr(audit_service, 'TRUSTED_PROXY_NETWORKS', (ipaddress.ip_network('127.0.0.1/32'),))
    assert audit_service.request_ip(
        request(None, '10.0.0.8, 192.168.10.25', '192.168.10.25')
    ) == '192.168.10.25'


def test_malformed_direct_peer_cannot_promote_forwarding_headers(monkeypatch):
    monkeypatch.setattr(audit_service, 'TRUSTED_PROXY_NETWORKS', (ipaddress.ip_network('127.0.0.1/32'),))
    assert audit_service.request_ip(request('not-an-ip', '1.2.3.4', '1.2.3.4')) is None


def test_generic_collection_audit_has_meaningful_target():
    req = Request({'type': 'http', 'method': 'GET', 'path': '/api/workspaces',
                   'path_params': {}, 'headers': [], 'client': ('192.168.10.25', 1234)})
    assert audit_service.request_audit_target(req, 'WORKSPACE') == (
        'WORKSPACE', None, '/api/workspaces',
    )


def test_generic_item_audit_records_route_identifiers():
    req = Request({'type': 'http', 'method': 'GET', 'path': '/api/workspaces/42',
                   'path_params': {'workspace_id': 42}, 'headers': [],
                   'client': ('192.168.10.25', 1234)})
    assert audit_service.request_audit_target(req, 'WORKSPACE') == (
        'WORKSPACE', 'workspace_id=42', None,
    )
