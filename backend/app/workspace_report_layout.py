"""Readable sections for the workspace-wide All Data Report.

The report query remains the single source of truth for visibility and counts.
These projections only organize its already-authorized rows for export.
"""

from collections import defaultdict


GUIDE = [
    ("Workspace Overview", "One line per visible workspace. Totals are split by requests, testing, defects, and governance."),
    ("Status Breakdown", "Counts by workspace, record type, and status. Zero-count statuses are omitted; zero totals remain in the overview."),
    ("Requests", "Main QA requests and their Functional, SAST, DAST, and Performance child requests. Each main request is counted once."),
    ("Projects / Testcases / Cycles", "Individual testing records. Project and cycle linked metrics show their current linked testcases, executions, and defects."),
    ("Executions / Attempts", "Executions show the latest result per testcase in a cycle. Attempts show every recorded run and may exceed the execution count."),
    ("Defects / Governance", "Individual defects, suppression requests, and QA clearances. Severity counts describe defects; they are not additional defects."),
    ("Reporting period", "The date filter applies to each record's creation or execution date. The linked metrics on a visible project or cycle reflect its current linked records."),
    ("Visibility", "Only records visible to the logged-in user are included. Private drafts and cancelled requests follow existing access rules; legacy unassigned records can appear separately."),
]


def _project(row, fields):
    return {label: row.get(source, "") for label, source in fields}


def all_data_sections(rows):
    """Return ordered (sheet title, projected rows, headers) tuples."""
    summaries = [r for r in rows if r.get("Row Type") == "Summary"]
    details = [r for r in rows if r.get("Row Type") == "Record"]
    workspace_names = list(dict.fromkeys(r["Workspace"] for r in summaries))
    totals = defaultdict(int)
    statuses = defaultdict(int)
    for row in summaries:
        key = (row["Workspace"], row["Module"])
        if row["Status"] == "Total":
            totals[key] = int(row.get("Count") or 0)
        else:
            statuses[(*key, row["Status"])] = int(row.get("Count") or 0)

    overview_headers = [
        "Workspace", "Main QA Requests", "Functional", "SAST", "DAST", "Performance",
        "Projects", "Testcases", "Cycles", "Execution Slots", "Passed", "Failed",
        "Blocked", "Not Executed", "Retest Passed", "Attempts", "Defects",
        "Critical Defects", "High Defects", "Suppressions", "QA Clearances",
    ]
    overview = []
    for name in workspace_names:
        total = lambda module: totals[(name, module)]
        result = lambda status: statuses[(name, "Test Execution", status)]
        overview.append(dict(zip(overview_headers, [
            name, total("QA Request"), total("Functional Request"), total("SAST Request"),
            total("DAST Request"), total("Performance Request"), total("Test Project"),
            total("Testcase"), total("Test Cycle"), total("Test Execution"),
            result("Pass"), result("Fail"), result("Blocked"), result("Not Executed"),
            result("Retest Passed"), total("Execution Attempt"), total("Defect"),
            statuses[(name, "Defect Severity", "Critical")],
            statuses[(name, "Defect Severity", "High")],
            total("Suppression Request"), total("QA Clearance"),
        ])))

    breakdown_headers = ["Workspace", "Record Type", "Status", "Count"]
    breakdown = [
        {"Workspace": r["Workspace"], "Record Type": r["Module"],
         "Status": r["Status"], "Count": int(r.get("Count") or 0)}
        for r in summaries if r["Status"] != "Total" and int(r.get("Count") or 0) > 0
    ]

    specs = [
        ("Requests", {"QA Request", "Functional Request", "SAST Request", "DAST Request", "Performance Request"}, [
            ("Workspace", "Workspace"), ("Request Type", "Module"), ("Request ID", "Record ID"),
            ("Parent QA Request", "Parent / Linked ID"), ("Application", "Application / Project"),
            ("Department", "Department"), ("Change Description", "Description"),
            ("Status", "Status"), ("Created At", "Created At"),
        ]),
        ("Projects", {"Test Project"}, [
            ("Workspace", "Workspace"), ("Project ID", "Record ID"), ("Project Name", "Application / Project"),
            ("Department", "Department"), ("Description", "Description"), ("Status", "Status"),
            ("Testcases", "Testcases"), ("Cycle Summary", "Execution Results"),
            ("Linked Defects", "Defects"), ("Created At", "Created At"),
        ]),
        ("Testcases", {"Testcase"}, [
            ("Workspace", "Workspace"), ("Testcase ID", "Record ID"), ("Project ID", "Parent / Linked ID"),
            ("Project Name", "Application / Project"), ("Scenario", "Description"),
            ("Status", "Status"), ("Created At", "Created At"),
        ]),
        ("Cycles", {"Test Cycle"}, [
            ("Workspace", "Workspace"), ("Cycle ID", "Record ID"), ("Project ID", "Parent / Linked ID"),
            ("Project Name", "Application / Project"), ("Cycle Name", "Description"),
            ("Status", "Status"), ("Testcases", "Testcases"),
            ("Execution Results", "Execution Results"), ("Linked Defects", "Defects"),
            ("Created At", "Created At"),
        ]),
        ("Executions", {"Test Execution"}, [
            ("Workspace", "Workspace"), ("Testcase ID", "Record ID"), ("Cycle ID", "Parent / Linked ID"),
            ("Project Name", "Application / Project"), ("Scenario", "Description"),
            ("Latest Result", "Status"), ("Assignment / Attempts", "Execution Results"),
            ("Linked Defects", "Defects"), ("Created At", "Created At"),
        ]),
        ("Attempts", {"Execution Attempt"}, [
            ("Workspace", "Workspace"), ("Testcase / Attempt", "Record ID"),
            ("Cycle ID", "Parent / Linked ID"), ("Project Name", "Application / Project"),
            ("Actual Result", "Description"), ("Result", "Status"), ("Executed At", "Created At"),
        ]),
        ("Defects", {"Defect"}, [
            ("Workspace", "Workspace"), ("Defect ID", "Record ID"), ("Linked Record", "Parent / Linked ID"),
            ("Application", "Application / Project"), ("Title", "Description"),
            ("Status", "Status"), ("Severity", "Execution Results"), ("Created At", "Created At"),
        ]),
        ("Governance", {"Suppression Request", "QA Clearance"}, [
            ("Workspace", "Workspace"), ("Record Type", "Module"), ("Record ID", "Record ID"),
            ("Linked Record", "Parent / Linked ID"), ("Application", "Application / Project"),
            ("Department", "Department"), ("Description", "Description"),
            ("Status", "Status"), ("Created At", "Created At"),
        ]),
    ]
    sections = [
        ("Guide", [{"Section": title, "What it shows": explanation} for title, explanation in GUIDE],
         ["Section", "What it shows"]),
        ("Workspace Overview", overview, overview_headers),
        ("Status Breakdown", breakdown, breakdown_headers),
    ]
    for title, modules, fields in specs:
        projected = [_project(row, fields) for row in details if row["Module"] in modules]
        if title == "Defects":
            for item in projected:
                item["Severity"] = str(item["Severity"]).removeprefix("Severity ")
        sections.append((title, projected, [label for label, _ in fields]))
    return sections
