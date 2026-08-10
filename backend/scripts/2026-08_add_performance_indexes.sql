-- Performance optimization indexes (IDX-001..007).
--
-- This app has no Alembic/migration tool (see backend/app/database.py's
-- module docstring) -- schema changes are additive-only via SQLAlchemy's
-- Base.metadata.create_all(), which only emits DDL for tables that do not
-- exist yet. A brand-new deployment (fresh schema) gets every index below
-- automatically, straight from backend/app/models.py's "Performance
-- optimization indexes" block. An EXISTING Oracle schema does not -- run
-- this script against it by hand, once, after deploying the corresponding
-- application code. Safe to re-run: every statement is guarded so it's a
-- no-op if the index already exists (ORA-01408/ORA-00955 avoided).
--
-- Every index name is <= 30 bytes (Oracle's identifier limit) -- see the
-- matching comment in models.py for names verified against it.
--
-- Run as the QA_PORTAL schema owner (or a user with CREATE INDEX on these
-- tables): sqlplus QA_PORTAL/<password>@<connect_string> @2026-08_add_performance_indexes.sql

WHENEVER SQLERROR CONTINUE

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_req_dept_status_created ON qap_requests (department, status, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1408 AND SQLCODE != -955 THEN RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_func_status_created ON qap_functional_requests (status, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1408 AND SQLCODE != -955 THEN RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_sast_status_created ON qap_sast_requests (status, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1408 AND SQLCODE != -955 THEN RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_dast_status_created ON qap_dast_requests (status, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1408 AND SQLCODE != -955 THEN RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_perf_status_created ON qap_performance_requests (status, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1408 AND SQLCODE != -955 THEN RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_appract_entity_created ON qap_approval_actions (entity_type, entity_id, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1408 AND SQLCODE != -955 THEN RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_tc_proj_folder_created ON qap_test_cases (project_id, folder_id, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1408 AND SQLCODE != -955 THEN RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_cyc_proj_status_created ON qap_test_cycles (project_id, status, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1408 AND SQLCODE != -955 THEN RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_readiness_func_req ON qap_readiness_checklist_items (functional_request_id)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1408 AND SQLCODE != -955 THEN RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_moddocs_req_uploaded ON qap_module_documents (module, request_id, uploaded_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1408 AND SQLCODE != -955 THEN RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_audit_actor_created ON qap_audit_logs (actor_id, created_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1408 AND SQLCODE != -955 THEN RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_audit_target ON qap_audit_logs (target_type, target_id)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1408 AND SQLCODE != -955 THEN RAISE; END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX ix_qap_defects_assignee_upd ON qap_defects (assignee_id, status, updated_at)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1408 AND SQLCODE != -955 THEN RAISE; END IF;
END;
/

-- Superseded single-column indexes (see the matching comment on each column
-- in models.py for why each is now redundant against the composite index
-- created above with the same leading column). Dropping these is OPTIONAL
-- -- leaving them in place is harmless (a small amount of wasted storage and
-- marginally slower writes on that one column), so this is commented out by
-- default. Uncomment only after confirming via Oracle execution plans
-- (IDX-001/IDX-006) that nothing in your workload still benefits from the
-- single-column form specifically.
--
-- DROP INDEX ix_qap_functional_requests_status;    -- exact name may differ; check USER_INDEXES first
-- DROP INDEX ix_qap_approval_actions_entity_type;
-- DROP INDEX ix_qap_audit_logs_actor_id;
-- DROP INDEX ix_qap_module_documents_module;
-- DROP INDEX ix_qap_defects_assignee_id;

-- IDX-007: after adding these indexes, refresh optimizer statistics per your
-- approved DBA procedure, e.g.:
-- EXEC DBMS_STATS.GATHER_TABLE_STATS(ownname => 'QA_PORTAL', tabname => 'QAP_REQUESTS');
-- (repeat for each table touched above, or gather schema-wide per your
-- standard maintenance window).

WHENEVER SQLERROR EXIT SQL.SQLCODE
