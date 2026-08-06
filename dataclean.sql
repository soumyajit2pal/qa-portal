-- 1. Review tables that will be cleared
SELECT table_name
FROM user_tables
WHERE UPPER(table_name) LIKE 'QAP\_%' ESCAPE '\'
ORDER BY table_name;

-- 2. Disable foreign keys
BEGIN
    FOR c IN (
        SELECT table_name, constraint_name
        FROM user_constraints
        WHERE constraint_type = 'R'
          AND UPPER(table_name) LIKE 'QAP\_%' ESCAPE '\'
    ) LOOP
        EXECUTE IMMEDIATE
            'ALTER TABLE "' || c.table_name ||
            '" DISABLE CONSTRAINT "' || c.constraint_name || '"';
    END LOOP;
END;
/

-- 3. Clear all QAP_* tables
BEGIN
    FOR t IN (
        SELECT table_name
        FROM user_tables
        WHERE UPPER(table_name) LIKE 'QAP\_%' ESCAPE '\'
    ) LOOP
        EXECUTE IMMEDIATE 'TRUNCATE TABLE "' || t.table_name || '"';
    END LOOP;
END;
/

-- 4. Enable foreign keys again
BEGIN
    FOR c IN (
        SELECT table_name, constraint_name
        FROM user_constraints
        WHERE constraint_type = 'R'
          AND UPPER(table_name) LIKE 'QAP\_%' ESCAPE '\'
    ) LOOP
        EXECUTE IMMEDIATE
            'ALTER TABLE "' || c.table_name ||
            '" ENABLE VALIDATE CONSTRAINT "' || c.constraint_name || '"';
    END LOOP;
END;
/

