-- 2026-08 -- reported directly: "some of the apis are taking lot of timing,
-- do some fine tuning."
--
-- This script has two parts:
--
--   Part 1 (IDX-001..007) -- the composite indexes already declared in
--   models.py's "Performance optimization indexes" block (see the header
--   comment on that block for the full IDX-001..007 rationale: department/
--   status scoping + newest-first sort on every paginated list endpoint,
--   project/folder/status lookups in Test Management, approval-action and
--   audit-log lookups, and the Defect assignee/status/updated-at combo).
--   That block's own comment has always pointed here for the manual DDL,
--   but this file never actually existed in the repo until this pass --
--   found and fixed as a byproduct of this same performance-tuning request,
--   not something the IDX-001..007 work itself introduced.
--
--   Part 2 (IDX-008) -- this pass's own new indexes: department on the two
--   module tables IDX-001..007 didn't reach (Suppression, Test Projects),
--   the parent-request FK on the four child-request tables (qa_request_id
--   on Functional/SAST/DAST/Performance), QASignOff.testing_request_id, and
--   TestFolder.project_id -- see each column's own comment in models.py.
--
-- IMPORTANT -- this app has no Alembic (see database.py's own module
-- docstring): schema changes are additive-only via `Base.metadata.
-- create_all()`, which only emits DDL for tables that don't already exist.
-- A brand-new deployment gets every index below automatically; an EXISTING
-- Oracle schema needs this run by hand:
--   sqlplus ... @2026-08_add_performance_indexes.sql
--
-- Every statement is guarded to be a safe no-op on re-run (ORA-00955 "name
-- is already used by an existing object" and ORA-01408 "such column list
-- already indexed" are both swallowed), same convention as this app's other
-- migration scripts (see 2026-08_add_defect_not_a_defect_column.sql).
-- Every index name is verified <= 30 bytes for Oracle's classic identifier
-- limit -- see the ORA-00972 note in models.py's own IDX-001..007 comment.

-- ---------------------------------------------------------------------
-- Part 1 -- IDX-001..007 (already declared in models.py, never migrated)
-- ---------------------------------------------------------------------

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_req_dept_status_created ON qap_requests (department, status, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_func_status_created ON qap_functional_requests (status, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_sast_status_created ON qap_sast_requests (status, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_dast_status_created ON qap_dast_requests (status, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_perf_status_created ON qap_performance_requests (status, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_appract_entity_created ON qap_approval_actions (entity_type, entity_id, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_tc_proj_folder_created ON qap_test_cases (project_id, folder_id, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_tc_proj_deleted_created ON qap_test_cases (project_id, is_deleted, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_cyc_proj_status_created ON qap_test_cycles (project_id, status, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_readiness_func_req ON qap_readiness_checklist_items (functional_request_id)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_moddocs_req_uploaded ON qap_module_documents (module, request_id, uploaded_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_audit_actor_created ON qap_audit_logs (actor_id, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_audit_target ON qap_audit_logs (target_type, target_id)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_defects_assignee_upd ON qap_defects (assignee_id, status, updated_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

-- ---------------------------------------------------------------------
-- Part 2 -- IDX-008 (this pass's own new indexes)
-- ---------------------------------------------------------------------

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_sup_dept ON qap_suppression_requests (department)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_proj_dept ON qap_test_projects (department)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_func_qa_req ON qap_functional_requests (qa_request_id)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_sast_qa_req ON qap_sast_requests (qa_request_id)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_dast_qa_req ON qap_dast_requests (qa_request_id)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_perf_qa_req ON qap_performance_requests (qa_request_id)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_signoff_testreq ON qap_signoffs (testing_request_id)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_test_folders_project_id ON qap_test_folders (project_id)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE IN (-955, -1408) THEN NULL; ELSE RAISE; END IF;
END;
/
