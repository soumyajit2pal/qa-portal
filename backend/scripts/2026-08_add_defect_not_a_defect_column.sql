-- 2026-08 -- "implement not a defect cycle, which is missing as per defect
-- cycle standard." Adds the one new column the new "Not a Defect" defect
-- status needs (models.Defect.not_a_defect_reason) -- mirrors
-- rejection_reason's own shape exactly (a single required free-text reason
-- captured when a defect is triaged as "Not a Defect" from New, same
-- pattern used throughout backend/scripts/ for every other manual ALTER
-- required by this app's no-Alembic, additive-only (`create_all()`)
-- convention -- see database.py's own docstring).
--
-- STILL NEEDS TO BE RUN BY HAND against the live Oracle schema before this
-- code is deployed: `sqlplus ... @2026-08_add_defect_not_a_defect_column.sql`
-- A brand-new deployment (fresh schema, no existing qap_defects table) gets
-- this column automatically from create_all() and does not need this script.
--
-- Guarded to be a safe no-op on re-run (ORA-01430 "column being added
-- already exists" is swallowed, same convention as this app's other
-- re-runnable migration scripts).
BEGIN
  EXECUTE IMMEDIATE 'ALTER TABLE qap_defects ADD (not_a_defect_reason CLOB)';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE = -1430 THEN
      NULL; -- column already exists -- already applied, nothing to do
    ELSE
      RAISE;
    END IF;
END;
/
