import tempfile
import unittest
from pathlib import Path

from app.config import load_environment


class ConfigurationProfileTests(unittest.TestCase):
    def test_profile_overrides_base_and_process_environment_wins(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").write_text(
                "APP_ENV=uat\nSETTING_FROM_BASE=base\nSHARED_VALUE=base\n",
                encoding="utf-8",
            )
            (root / ".env.uat").write_text(
                "SHARED_VALUE=uat\nPROFILE_ONLY=present\nPROCESS_VALUE=file\n",
                encoding="utf-8",
            )
            environ = {"PROCESS_VALUE": "process"}

            profile, loaded = load_environment(backend_dir=root, environ=environ)

            self.assertEqual(profile, "uat")
            self.assertEqual(loaded, (root / ".env", root / ".env.uat"))
            self.assertEqual(environ["SETTING_FROM_BASE"], "base")
            self.assertEqual(environ["SHARED_VALUE"], "uat")
            self.assertEqual(environ["PROFILE_ONLY"], "present")
            self.assertEqual(environ["PROCESS_VALUE"], "process")
            self.assertEqual(environ["APP_ENV"], "uat")

    def test_explicit_profile_selects_matching_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").write_text("APP_ENV=dev\nVALUE=base\n", encoding="utf-8")
            (root / ".env.prod").write_text("VALUE=prod\n", encoding="utf-8")
            environ = {"APP_ENV": "prod"}

            profile, _ = load_environment(backend_dir=root, environ=environ)

            self.assertEqual(profile, "prod")
            self.assertEqual(environ["VALUE"], "prod")

    def test_root_profile_is_fallback_when_backend_profile_is_absent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend = root / "backend"
            backend.mkdir()
            (root / ".env.uat").write_text(
                "DATABASE_URL=oracle+oracledb://user:password@db:1521/?service_name=UAT\n",
                encoding="utf-8",
            )
            environ = {"APP_ENV": "uat"}

            profile, loaded = load_environment(backend_dir=backend, environ=environ)

            self.assertEqual(profile, "uat")
            self.assertEqual(loaded, (root / ".env.uat",))
            self.assertTrue(environ["DATABASE_URL"].startswith("oracle+oracledb://"))

    def test_invalid_profile_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                load_environment(
                    backend_dir=Path(directory),
                    environ={"APP_ENV": "../../prod"},
                )


if __name__ == "__main__":
    unittest.main()
