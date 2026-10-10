"""Restartable additions for Oracle migrations that retain audit evidence."""
from alembic import context, op
import sqlalchemy as sa


def _guarded_oracle_ddl(catalog, predicate, ddl):
    # Names and DDL come only from checked-in migration definitions.
    literal = ddl.replace("'", "''")
    op.execute(sa.text(f"""DECLARE
    existing_count PLS_INTEGER;
BEGIN
    SELECT COUNT(*) INTO existing_count FROM {catalog} WHERE {predicate};
    IF existing_count = 0 THEN
        EXECUTE IMMEDIATE '{literal}';
    END IF;
END;"""))


def ensure_column(table_name, column):
    if context.is_offline_mode():
        dialect = op.get_bind().dialect
        definition = str(sa.schema.CreateColumn(column).compile(dialect=dialect))
        _guarded_oracle_ddl(
            "USER_TAB_COLUMNS",
            f"TABLE_NAME = '{table_name.upper()}' AND COLUMN_NAME = '{column.name.upper()}'",
            f"ALTER TABLE {table_name} ADD {definition}",
        )
    else:
        columns = sa.inspect(op.get_bind()).get_columns(table_name)
        if column.name.lower() not in {item["name"].lower() for item in columns}:
            op.add_column(table_name, column)


def _ensure_constraint(table_name, name, constraint, create, kind):
    if context.is_offline_mode():
        ddl = str(sa.schema.AddConstraint(constraint).compile(dialect=op.get_bind().dialect)).strip()
        _guarded_oracle_ddl(
            "USER_CONSTRAINTS",
            f"TABLE_NAME = '{table_name.upper()}' AND CONSTRAINT_NAME = '{name.upper()}'",
            ddl,
        )
    else:
        inspector = sa.inspect(op.get_bind())
        constraints = inspector.get_unique_constraints(table_name) if kind == "unique" else inspector.get_foreign_keys(table_name)
        if name.lower() not in {(item["name"] or "").lower() for item in constraints}:
            create()


def ensure_unique_constraint(name, table_name, columns):
    metadata = sa.MetaData()
    table = sa.Table(table_name, metadata, *(sa.Column(column, sa.Integer) for column in columns))
    constraint = sa.UniqueConstraint(*columns, name=name)
    table.append_constraint(constraint)
    _ensure_constraint(table_name, name, constraint, lambda: op.create_unique_constraint(name, table_name, columns), "unique")


def ensure_foreign_key(name, table_name, referred_table, columns, referred_columns):
    metadata = sa.MetaData()
    table = sa.Table(table_name, metadata, *(sa.Column(column, sa.Integer) for column in columns))
    sa.Table(referred_table, metadata, *(sa.Column(column, sa.Integer) for column in referred_columns))
    constraint = sa.ForeignKeyConstraint(columns, [f"{referred_table}.{column}" for column in referred_columns], name=name)
    table.append_constraint(constraint)
    _ensure_constraint(table_name, name, constraint, lambda: op.create_foreign_key(name, table_name, referred_table, columns, referred_columns), "foreign_key")


def ensure_index(name, table_name, columns):
    if context.is_offline_mode():
        table = sa.Table(table_name, sa.MetaData(), *(sa.Column(column, sa.Integer) for column in columns))
        index = sa.Index(name, *(table.c[column] for column in columns))
        ddl = str(sa.schema.CreateIndex(index).compile(dialect=op.get_bind().dialect)).strip()
        _guarded_oracle_ddl("USER_INDEXES", f"INDEX_NAME = '{name.upper()}'", ddl)
    else:
        indexes = sa.inspect(op.get_bind()).get_indexes(table_name)
        if name.lower() not in {(item['name'] or '').lower() for item in indexes}:
            op.create_index(name, table_name, columns)
