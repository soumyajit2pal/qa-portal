"""Certificate-verified LDAP transport using Python's native TLS checks.

ldap3 2.9's wrapper omits SNI unless explicitly configured and constructs a
context which cannot anchor a chain at an explicitly trusted intermediate CA.
Keep ldap3's transport interface while owning the client context and verifying
the actual connection hostname, including any referral endpoint.
"""
import ssl

from ldap3 import Tls


class DirectoryTls(Tls):
    def __init__(self, *, ca_certs_file=None, ca_certs_data=None):
        super().__init__(
            validate=ssl.CERT_REQUIRED,
            version=ssl.PROTOCOL_TLS_CLIENT,
            ca_certs_file=ca_certs_file,
            ca_certs_data=ca_certs_data,
        )

    def wrap_socket(self, connection, do_handshake=False):
        # PROTOCOL_TLS_CLIENT enables chain and native hostname validation.
        # Use the same verification policy on supported Python versions rather
        # than inheriting version-dependent create_default_context flags.
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        if self.ca_certs_file or self.ca_certs_data:
            context.load_verify_locations(
                cafile=self.ca_certs_file, cadata=self.ca_certs_data,
            )
            # Uploads are validated CA certificates deliberately trusted by
            # the administrator. An issuing CA may therefore terminate the
            # verified chain, just as a root can. This never trusts a peer's
            # unconfigured CA or bypasses signatures, expiry or hostname checks.
            context.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
        else:
            context.load_default_certs(ssl.Purpose.SERVER_AUTH)
        connection.socket = context.wrap_socket(
            connection.socket,
            server_side=False,
            do_handshake_on_connect=do_handshake,
            server_hostname=connection.server.host,
        )
