import unittest
import urllib.parse

from app.fortify_ssc import FortifySSCClient


def grouped_counts(critical: int, high: int, medium: int, low: int) -> dict:
    return {
        "data": [
            {"id": "Critical", "totalCount": critical},
            {"id": "High", "totalCount": high},
            {"id": "Medium", "totalCount": medium},
            {"id": "Low", "totalCount": low},
        ]
    }


class FakeFortifyClient(FortifySSCClient):
    def __init__(self):
        self.base_url = "https://ssc.example.test"
        self.requested_paths: list[str] = []

    def _get(self, path: str) -> dict:
        self.requested_paths.append(path)
        if path == "projects?count=-1":
            return {"data": [{"id": 10, "name": "Payments"}]}
        if path == "projects/10/versions?count=-1":
            return {"data": [{"id": 20, "name": "1.2.3"}]}
        if path == "projectVersions/20/filterSets":
            return {
                "data": [
                    {"guid": "auditor-guid", "title": "Security Auditor View"},
                    {"guid": "quick-guid", "title": "Quick View"},
                ]
            }
        if path.startswith("projectVersions/20/issueGroups?"):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
            guid = query["filterset"][0]
            includes_suppressed = query["showsuppressed"][0] == "true"
            if guid == "auditor-guid" and includes_suppressed:
                return grouped_counts(7, 4, 2, 2)
            if guid == "auditor-guid":
                return grouped_counts(5, 3, 2, 1)
            if guid == "quick-guid":
                return grouped_counts(2, 1, 0, 0)
        raise AssertionError(f"Unexpected Fortify request: {path}")


class FortifySuppressedFindingTests(unittest.TestCase):
    def test_snapshot_uses_primary_filter_delta_for_suppressed_severities(self):
        client = FakeFortifyClient()

        snapshot = client.retrieve_snapshot("Payments", "1.2.3")

        self.assertEqual(snapshot.critical_count, 5)
        self.assertEqual(snapshot.total_count, 11)
        self.assertEqual(snapshot.suppressed_critical_count, 2)
        self.assertEqual(snapshot.suppressed_high_count, 1)
        self.assertEqual(snapshot.suppressed_medium_count, 0)
        self.assertEqual(snapshot.suppressed_low_count, 1)
        self.assertEqual(snapshot.suppressed_total_count, 4)
        suppressed_queries = [
            path for path in client.requested_paths if "showsuppressed=true" in path
        ]
        self.assertEqual(len(suppressed_queries), 1)
        self.assertIn("filterset=auditor-guid", suppressed_queries[0])


if __name__ == "__main__":
    unittest.main()
