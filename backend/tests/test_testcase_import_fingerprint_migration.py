import importlib.util
from pathlib import Path

import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "8c6f0a1b2d43_add_testcase_import_fingerprint.py"
)


def _migration_module():
    spec = importlib.util.spec_from_file_location("testcase_import_fingerprint_migration", MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _inspector(*, unique: str | None = None):
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    table = sa.Table(
        "qap_test_cases",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("project_id", sa.Integer, nullable=False),
        sa.Column("import_fingerprint", sa.String(64)),
    )
    if unique == "constraint":
        table.append_constraint(
            sa.UniqueConstraint(
                "project_id",
                "import_fingerprint",
                name="uq_qap_tc_project_import_fp",
            )
        )
    elif unique == "index":
        sa.Index(
            "uq_existing_import_fingerprint",
            table.c.project_id,
            table.c.import_fingerprint,
            unique=True,
        )
    metadata.create_all(engine)
    return sa.inspect(engine)


def test_existing_column_is_detected_before_add_column_retry():
    migration = _migration_module()

    assert migration._has_column(_inspector())


def test_existing_unique_constraint_or_index_satisfies_migration():
    migration = _migration_module()

    assert migration._has_import_fingerprint_uniqueness(_inspector(unique="constraint"))
    assert migration._has_import_fingerprint_uniqueness(_inspector(unique="index"))
    assert not migration._has_import_fingerprint_uniqueness(_inspector())


def test_duplicate_cleanup_preserves_rows_and_keeps_earliest_fingerprint():
    migration = _migration_module()
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    cases = sa.Table(
        "qap_test_cases",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("project_id", sa.Integer, nullable=False),
        sa.Column("import_fingerprint", sa.String(64)),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(cases.insert(), [
            {"id": 1, "project_id": 10, "import_fingerprint": "same"},
            {"id": 2, "project_id": 10, "import_fingerprint": "same"},
            {"id": 3, "project_id": 10, "import_fingerprint": "different"},
            {"id": 4, "project_id": 20, "import_fingerprint": "same"},
        ])
        migration._clear_duplicate_import_fingerprints(connection)
        rows = connection.execute(
            sa.select(cases.c.id, cases.c.project_id, cases.c.import_fingerprint).order_by(cases.c.id)
        ).all()

    assert rows == [
        (1, 10, "same"),
        (2, 10, None),
        (3, 10, "different"),
        (4, 20, "same"),
    ]
