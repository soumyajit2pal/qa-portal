"""Prevent numeric Oracle Boolean predicates from regressing anywhere in app code."""
import ast
from pathlib import Path


def test_no_boolean_is_predicates_in_backend():
    violations = []
    for path in (Path(__file__).parents[1] / 'app').rglob('*.py'):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            if node.func.attr not in {'is_', 'isnot', 'is_not'} or not node.args:
                continue
            arg = node.args[0]
            unsafe_literal = isinstance(arg, ast.Constant) and isinstance(arg.value, (bool, int))
            unsafe_function = (isinstance(arg, ast.Call) and
                               isinstance(arg.func, (ast.Name, ast.Attribute)) and
                               (getattr(arg.func, 'id', None) or getattr(arg.func, 'attr', None)) in {'true', 'false'})
            if unsafe_literal or unsafe_function:
                violations.append(f'{path.name}:{node.lineno}')
    assert not violations, 'Use equality for Oracle numeric Booleans: ' + ', '.join(violations)
