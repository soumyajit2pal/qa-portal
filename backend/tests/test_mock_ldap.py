from unittest.mock import patch

import pytest
from pydantic import ValidationError

from app import auth
from app.config import Settings


def test_mock_ldap_accepts_only_configured_prefix_and_password():
    with (
        patch.object(auth.settings, "ldap_mock_enabled", True),
        patch.object(auth.settings, "ldap_mock_username_prefix", "bmock"),
        patch.object(auth.settings, "ldap_mock_password", "QualityOps-Mock-LDAP-2026!"),
    ):
        profile = auth.ldap_authenticate_with_profile("bmock01", "QualityOps-Mock-LDAP-2026!")
        assert profile == {
            "dn": "mock:bmock01",
            "full_name": "Mock LDAP 01",
            "email": "bmock01@mock-ldap.test",
            "department": None,
        }
        assert auth.ldap_authenticate("bmock01", "wrong-password") is False


def test_mock_ldap_does_not_intercept_other_usernames():
    with (
        patch.object(auth.settings, "ldap_mock_enabled", True),
        patch.object(auth.settings, "ldap_mock_username_prefix", "bmock"),
        patch.object(auth.settings, "ldap_mock_password", "QualityOps-Mock-LDAP-2026!"),
    ):
        profile, handled = auth._mock_ldap_profile("breal01", "QualityOps-Mock-LDAP-2026!")
        assert handled is False
        assert profile is None


def test_mock_ldap_is_allowed_in_uat_but_rejected_in_production():
    common = {
        "database_url": "sqlite:///mock-ldap.db",
        "secret_key": "mock-ldap-test-secret-that-is-long-enough",
        "ldap_mock_enabled": True,
        "ldap_mock_username_prefix": "bmock",
        "ldap_mock_password": "QualityOps-Mock-LDAP-2026!",
    }

    assert Settings(app_env="uat", **common).ldap_mock_enabled is True
    with pytest.raises(ValidationError, match="cannot be enabled in production"):
        Settings(app_env="production", **common)
