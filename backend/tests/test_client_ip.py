import ipaddress
from starlette.requests import Request
from app import audit_service


def request(peer, forwarded):
    return Request({'type': 'http', 'client': (peer, 1234), 'headers': [(b'x-forwarded-for', forwarded.encode())]})


def test_trusted_local_proxy_records_browser_ip(monkeypatch):
    monkeypatch.setattr(audit_service, 'TRUSTED_PROXY_NETWORKS', (ipaddress.ip_network('127.0.0.1/32'),))
    assert audit_service.request_ip(request('127.0.0.1', '192.168.10.25')) == '192.168.10.25'


def test_untrusted_client_cannot_forge_source_ip(monkeypatch):
    monkeypatch.setattr(audit_service, 'TRUSTED_PROXY_NETWORKS', (ipaddress.ip_network('127.0.0.1/32'),))
    assert audit_service.request_ip(request('192.168.10.25', '1.2.3.4')) == '192.168.10.25'
