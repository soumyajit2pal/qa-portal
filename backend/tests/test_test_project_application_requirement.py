import unittest

from pydantic import ValidationError

from app.schemas import TestProjectCreate as ProjectCreateSchema


class TestProjectApplicationRequirementTests(unittest.TestCase):
    def test_project_creation_requires_an_application(self):
        with self.assertRaises(ValidationError):
            ProjectCreateSchema(name="Portal", department="IT - Software")

    def test_project_creation_accepts_an_application(self):
        project = ProjectCreateSchema(
            name="Portal",
            application_master_id=17,
            department="IT - Software",
        )

        self.assertEqual(project.application_master_id, 17)


if __name__ == "__main__":
    unittest.main()
