"""Production API inventory and authentication-boundary regression checks."""
import importlib
from pathlib import Path

from fastapi.routing import APIRoute


PUBLIC_OR_SELF_AUTHENTICATING = {
    ("GET", "/api/auth/login-key"),
    ("POST", "/api/auth/login"),
    # Logout resolves and revokes the opaque cookie inside its handler so it
    # can also clear an already-expired cookie idempotently.
    ("POST", "/api/auth/logout"),
}
AUTH_DEPENDENCIES = {
    "get_current_user",
    "get_workflow_user",
    "get_document_portal_current_user",
    "checker",  # closure returned by require_roles()/require_workflow_roles()
}
RETIRED_PATH_PARTS = {
    "/api/qa-workspaces",
    "/test-cases/all",
    "/executions/case-ids",
    "/department-head-coe-decision",
}


def _dependency_names(route: APIRoute) -> set[str]:
    names: set[str] = set()

    def visit(dependant):
        if dependant.call:
            names.add(getattr(dependant.call, "__name__", type(dependant.call).__name__))
        for child in dependant.dependencies:
            visit(child)

    visit(route.dependant)
    return names


def _application_routes() -> list[APIRoute]:
    router_dir = Path(__file__).resolve().parents[1] / "app" / "routers"
    routes: list[APIRoute] = []
    for source in sorted(router_dir.glob("*.py")):
        if source.stem == "__init__":
            continue
        module = importlib.import_module(f"app.routers.{source.stem}")
        router = getattr(module, "router", None)
        if router is not None:
            routes.extend(route for route in router.routes if isinstance(route, APIRoute))
    return routes


def test_no_deprecated_or_legacy_api_routes_remain_registered():
    routes = _application_routes()
    assert not [route.path for route in routes if route.deprecated]
    assert not [
        route.path for route in routes
        if any(retired in route.path for retired in RETIRED_PATH_PARTS)
    ]


def test_every_nonpublic_api_route_has_a_server_authentication_dependency():
    unprotected = []
    for route in _application_routes():
        for method in route.methods:
            if (method, route.path) in PUBLIC_OR_SELF_AUTHENTICATING:
                continue
            if not (_dependency_names(route) & AUTH_DEPENDENCIES):
                unprotected.append(f"{method} {route.path}")
    assert not unprotected, "Routes without a server authentication dependency: " + ", ".join(unprotected)
