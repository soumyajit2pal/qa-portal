"""One exact association predicate for register rows, counts and exports."""
from sqlalchemy import or_
from . import models


def functional_request_condition(request_id=None):
    request = models.TestCycleChildRequestLink.functional_request.has(
        models.FunctionalRequest.id == request_id) if request_id is not None else models.TestCycleChildRequestLink.functional_request.has()
    cycle = models.TestCycle.child_request_link.has(request)
    return or_(
        models.Defect.functional_request_links.any(
            models.DefectFunctionalRequestLink.functional_request_id == request_id
        ) if request_id is not None else models.Defect.functional_request_links.any(),
        models.Defect.cycle.has(cycle),
        models.Defect.execution.has(models.TestExecution.cycle.has(cycle)),
        models.Defect.execution_links.any(models.DefectExecutionLink.execution.has(models.TestExecution.cycle.has(cycle))),
        models.Defect.historical_execution_links.any(models.TestRunDefect.run.has(
            models.TestExecutionRun.execution.has(models.TestExecution.cycle.has(cycle)))),
    )
