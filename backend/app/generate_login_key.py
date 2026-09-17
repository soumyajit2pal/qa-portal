"""Generate a deployment-owned login key: python -m app.generate_login_key PATH."""
import os
import sys
from pathlib import Path
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa


def generate(filename):
    path = Path(filename)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption())
    # Never overwrite a key used by another deployment or worker.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(pem)
    print('Login encryption key created. Keep this file private and mount it read-only in the API.')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python -m app.generate_login_key PATH')
    generate(sys.argv[1])
