import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import models, schemas
from app.routers.test_execution import _cycle_candidate_query


def test_creator_filter_applies_to_approved_unlinked_cycle_candidates():
    engine = create_engine("sqlite:///:memory:")
    models.Base.metadata.create_all(engine)
    with Session(engine) as db:
        authors = [
            models.User(username=name, full_name=name, hashed_password="x", is_active=True)
            for name in ("Author One", "Author Two")
        ]
        project = models.TestProject(project_key="P-CREATOR", name="Creator filter project")
        db.add_all([*authors, project])
        db.flush()
        cycle = models.TestCycle(project=project, cycle_key="CY-CREATOR", name="Cycle")
        db.add(cycle)
        db.flush()

        def approved_case(key, author, linked=False):
            case = models.TestCase(
                project=project, test_case_key=key, created_by=author,
                created_at=datetime.datetime(2026, 9, 16, 10, 0),
            )
            db.add(case)
            db.flush()
            version = models.TestCaseVersion(test_case=case, status="Approved")
            db.add(version)
            db.flush()
            case.current_approved_version_id = version.id
            if linked:
                db.add(models.TestExecution(cycle=cycle, test_case=case))
            return case

        one = approved_case("TC-ONE", authors[0])
        two = approved_case("TC-TWO", authors[1])
        approved_case("TC-ALREADY-LINKED", authors[0], linked=True)
        db.commit()

        assert {case.id for case in _cycle_candidate_query(db, cycle).all()} == {one.id, two.id}
        assert [case.id for case in _cycle_candidate_query(db, cycle, created_by_id=authors[0].id).all()] == [one.id]
        assert [case.id for case in _cycle_candidate_query(db, cycle, created_by_id=authors[1].id).all()] == [two.id]
        candidate = schemas.TestCaseCandidateOut.model_validate(one)
        assert candidate.created_by_name == "Author One"
        assert candidate.created_at == datetime.datetime(2026, 9, 16, 10, 0)
