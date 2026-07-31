from __future__ import annotations

import ast
from dataclasses import dataclass
import hashlib
import json
from pathlib import PurePosixPath
import re
from typing import Iterable

from .dependency_graph import deduplicate_edges
from .repository_contract import (
    RepositoryDependency,
    RepositorySymbol,
    ValidationCapability,
)


SUPPORTED_SOURCE_EXTENSIONS = frozenset({
    ".py", ".pyi", ".js", ".jsx", ".ts", ".tsx",
})
SUPPORTED_CONFIG_NAMES = frozenset({
    "package.json", "tsconfig.json", "pyproject.toml", "requirements.txt",
    "requirements-dev.txt", "setup.cfg", "tox.ini", ".eslintrc",
    ".eslintrc.json", "vite.config.js", "vite.config.ts",
})


@dataclass(frozen=True)
class RepositorySourceFile:
    path: str
    text: str
    content_hash: str
    language: str
    line_count: int


@dataclass(frozen=True)
class RepositoryIndex:
    files: tuple[RepositorySourceFile, ...]
    symbols: tuple[RepositorySymbol, ...]
    edges: tuple[RepositoryDependency, ...]
    languages: tuple[str, ...]
    frameworks: tuple[str, ...]
    dependency_versions: tuple[tuple[str, str], ...]
    tool_versions: tuple[tuple[str, str], ...]
    validation_capabilities: tuple[ValidationCapability, ...]

    def __post_init__(self) -> None:
        if len(self.files) > 5_000:
            raise ValueError("repository file index exceeds the bound")
        if len(self.symbols) > 50_000 or len(self.edges) > 100_000:
            raise ValueError("repository symbol index exceeds the bound")


def language_for_path(path: str) -> str:
    suffix = PurePosixPath(path).suffix.lower()
    return {
        ".py": "python",
        ".pyi": "python",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".js": "javascript",
        ".jsx": "javascript",
        ".json": "json",
        ".toml": "toml",
        ".yaml": "yaml",
        ".yml": "yaml",
    }.get(suffix, "text")


def source_file(path: str, text: str) -> RepositorySourceFile:
    encoded = text.encode("utf-8")
    return RepositorySourceFile(
        path=path,
        text=text,
        content_hash=hashlib.sha256(encoded).hexdigest(),
        language=language_for_path(path),
        line_count=max(1, text.count("\n") + 1),
    )


def build_repository_index(
    files: Iterable[RepositorySourceFile],
) -> RepositoryIndex:
    bounded_files = tuple(sorted(files, key=lambda item: item.path)[:5_000])
    symbols: list[RepositorySymbol] = []
    edges: list[RepositoryDependency] = []
    frameworks: set[str] = set()
    dependency_versions: dict[str, str] = {}
    tool_versions: dict[str, str] = {}
    capabilities: dict[str, ValidationCapability] = {}

    for item in bounded_files:
        if item.language == "python":
            parsed_symbols, parsed_edges = _parse_python(item)
            symbols.extend(parsed_symbols)
            edges.extend(parsed_edges)
            capabilities["python_ast"] = ValidationCapability(
                "python_ast", "syntax", executable=False, required=True
            )
            capabilities["python_compile"] = ValidationCapability(
                "python_compile", "syntax", executable=True
            )
        elif item.language in {"typescript", "javascript"}:
            parsed_symbols, parsed_edges = _parse_ecmascript(item)
            symbols.extend(parsed_symbols)
            edges.extend(parsed_edges)
            capabilities["typescript_parse"] = ValidationCapability(
                "typescript_parse", "syntax", executable=False, required=True
            )
            capabilities["typescript_typecheck"] = ValidationCapability(
                "typescript_typecheck", "typecheck", executable=True
            )
        _inspect_configuration(
            item,
            frameworks=frameworks,
            dependencies=dependency_versions,
            tools=tool_versions,
            capabilities=capabilities,
        )
    _detect_frameworks(bounded_files, symbols, frameworks)
    if any(item.kind == "route" for item in symbols):
        capabilities["api_schema_static"] = ValidationCapability(
            "api_schema_static", "api_schema", executable=False
        )
    if any(
        "alembic/versions/" in item.path.casefold()
        or "/migrations/" in item.path.casefold()
        for item in bounded_files
    ):
        capabilities["migration_upgrade"] = ValidationCapability(
            "migration_upgrade", "migration", executable=True
        )
    if any(
        item.kind == "test"
        and any(
            value in f"{item.path}:{item.name}".casefold()
            for value in ("auth", "owner", "permission")
        )
        for item in symbols
    ):
        capabilities["authorization_tests"] = ValidationCapability(
            "authorization_tests", "authorization", executable=True
        )
    return RepositoryIndex(
        files=bounded_files,
        symbols=tuple(sorted(
            symbols,
            key=lambda item: (
                item.path, item.start_line, item.kind, item.name
            ),
        )[:50_000]),
        edges=deduplicate_edges(edges)[:100_000],
        languages=tuple(sorted({
            item.language for item in bounded_files
            if item.language not in {"text", "json", "toml", "yaml"}
        })),
        frameworks=tuple(sorted(frameworks))[:24],
        dependency_versions=tuple(sorted(dependency_versions.items()))[:128],
        tool_versions=tuple(sorted(tool_versions.items()))[:32],
        validation_capabilities=tuple(
            capabilities[key] for key in sorted(capabilities)
        )[:24],
    )


def _signature(source: str, node: ast.AST) -> str:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        arguments = [
            *node.args.posonlyargs,
            *node.args.args,
            *node.args.kwonlyargs,
        ]
        rendered = [
            argument.arg + (
                f":{_annotation(argument.annotation)}"
                if argument.annotation is not None else ""
            )
            for argument in arguments
        ]
        if node.args.vararg:
            rendered.append(f"*{node.args.vararg.arg}")
        if node.args.kwarg:
            rendered.append(f"**{node.args.kwarg.arg}")
        returns = (
            f" -> {_annotation(node.returns)}"
            if node.returns is not None else ""
        )
        prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
        return f"{prefix} {node.name}({', '.join(rendered)}){returns}"[:512]
    if isinstance(node, ast.ClassDef):
        bases = ", ".join(
            value for value in (_python_name(base) for base in node.bases)
            if value
        )
        return f"class {node.name}" + (f"({bases})" if bases else "")
    return ""


def _annotation(node: ast.AST | None) -> str:
    if node is None:
        return ""
    if isinstance(node, ast.Name):
        return node.id[:80]
    if isinstance(node, ast.Attribute):
        return _python_name(node)[:80]
    if isinstance(node, ast.Subscript):
        return (
            f"{_annotation(node.value)}[{_annotation(node.slice)}]"
        )[:160]
    if isinstance(node, (ast.Tuple, ast.List)):
        return ",".join(_annotation(value) for value in node.elts)[:160]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return f"{_annotation(node.left)}|{_annotation(node.right)}"[:160]
    return "annotation"


class _PythonVisitor(ast.NodeVisitor):
    def __init__(self, item: RepositorySourceFile):
        self.item = item
        self.symbols: list[RepositorySymbol] = []
        self.edges: list[RepositoryDependency] = []
        self.scope: list[str] = []

    def _add(
        self,
        node: ast.AST,
        name: str,
        kind: str,
        signature: str | None = None,
    ) -> None:
        start = max(1, int(getattr(node, "lineno", 1)))
        end = max(start, int(getattr(node, "end_lineno", start)))
        qualified = ".".join([*self.scope, name]) if self.scope else name
        self.symbols.append(RepositorySymbol(
            path=self.item.path,
            name=qualified[:160],
            kind=kind,
            signature=(
                _signature(self.item.text, node)
                if signature is None else signature[:512]
            ),
            start_line=start,
            end_line=end,
        ))

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        kind = "test" if node.name.startswith("test") else "function"
        decorators = [
            _python_name(value) for value in node.decorator_list
        ]
        if any(
            value.split(".")[-1] in {
                "get", "post", "put", "patch", "delete", "options", "head"
            }
            for value in decorators
        ):
            kind = "route"
        signature = None
        if kind == "route":
            for decorator in node.decorator_list:
                if (
                    isinstance(decorator, ast.Call)
                    and decorator.args
                    and isinstance(decorator.args[0], ast.Constant)
                    and isinstance(decorator.args[0].value, str)
                ):
                    path = decorator.args[0].value
                    if (
                        path.startswith("/")
                        and len(path) <= 200
                        and not any(ord(char) < 32 for char in path)
                    ):
                        method = _python_name(decorator.func).split(".")[-1]
                        signature = (
                            f"{method.upper()} {path} — "
                            f"{_signature(self.item.text, node)}"
                        )
                        break
        self._add(node, node.name, kind, signature)
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        bases = {_python_name(value) for value in node.bases}
        kind = (
            "model"
            if bases & {"SQLModel", "BaseModel", "DeclarativeBase"}
            else "class"
        )
        signature = _signature(self.item.text, node)
        if kind == "model":
            fields = []
            for child in node.body:
                if isinstance(child, ast.AnnAssign) and isinstance(
                    child.target, ast.Name
                ):
                    fields.append(
                        f"{child.target.id}:{_annotation(child.annotation)}"
                    )
            if fields:
                signature = (
                    f"class {node.name}({', '.join(fields[:32])})"
                )[:512]
        self._add(node, node.name, kind, signature)
        for base in sorted(bases):
            if base:
                self.edges.append(RepositoryDependency(
                    source=f"{self.item.path}:{node.name}",
                    target=base,
                    kind="extends",
                ))
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.edges.append(RepositoryDependency(
                source=self.item.path,
                target=alias.name[:512],
                kind="imports",
            ))

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = ("." * int(node.level)) + str(node.module or "")
        for alias in node.names:
            self.edges.append(RepositoryDependency(
                source=self.item.path,
                target=f"{module}:{alias.name}"[:512],
                kind="imports",
            ))

    def visit_Call(self, node: ast.Call) -> None:
        if self.scope:
            target = _python_name(node.func)
            if target:
                self.edges.append(RepositoryDependency(
                    source=f"{self.item.path}:{'.'.join(self.scope)}",
                    target=target[:512],
                    kind="calls",
                ))
        self.generic_visit(node)


def _python_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        left = _python_name(node.value)
        return f"{left}.{node.attr}" if left else node.attr
    if isinstance(node, ast.Call):
        return _python_name(node.func)
    return ""


def _parse_python(
    item: RepositorySourceFile,
) -> tuple[list[RepositorySymbol], list[RepositoryDependency]]:
    try:
        tree = ast.parse(item.text, filename=item.path, type_comments=True)
    except (SyntaxError, ValueError):
        return [], []
    visitor = _PythonVisitor(item)
    visitor.visit(tree)
    visitor.symbols.insert(0, RepositorySymbol(
        path=item.path,
        name=item.path.replace("/", ".").rsplit(".", 1)[0][:160],
        kind="module",
        signature="",
        start_line=1,
        end_line=item.line_count,
    ))
    return visitor.symbols, visitor.edges


@dataclass(frozen=True)
class _Token:
    value: str
    line: int
    kind: str


def _ecmascript_tokens(text: str) -> list[_Token]:
    """Small deterministic lexer; it skips comments and never executes code."""

    tokens: list[_Token] = []
    index = 0
    line = 1
    size = len(text)
    while index < size and len(tokens) < 200_000:
        char = text[index]
        if char == "\n":
            line += 1
            index += 1
            continue
        if char.isspace():
            index += 1
            continue
        if text.startswith("//", index):
            index = text.find("\n", index)
            if index < 0:
                break
            continue
        if text.startswith("/*", index):
            end = text.find("*/", index + 2)
            if end < 0:
                break
            line += text[index:end + 2].count("\n")
            index = end + 2
            continue
        if char in {"'", '"', "`"}:
            quote = char
            start_line = line
            index += 1
            value: list[str] = []
            escaped = False
            while index < size:
                current = text[index]
                if current == "\n":
                    line += 1
                if escaped:
                    escaped = False
                elif current == "\\":
                    escaped = True
                elif current == quote:
                    index += 1
                    break
                value.append(current)
                index += 1
            tokens.append(_Token("".join(value)[:512], start_line, "string"))
            continue
        if char.isalpha() or char in {"_", "$"}:
            start = index
            index += 1
            while index < size and (
                text[index].isalnum() or text[index] in {"_", "$"}
            ):
                index += 1
            tokens.append(_Token(text[start:index], line, "identifier"))
            continue
        tokens.append(_Token(char, line, "punctuation"))
        index += 1
    return tokens


def _parse_ecmascript(
    item: RepositorySourceFile,
) -> tuple[list[RepositorySymbol], list[RepositoryDependency]]:
    tokens = _ecmascript_tokens(item.text)
    symbols: list[RepositorySymbol] = []
    edges: list[RepositoryDependency] = []
    declaration_kinds = {
        "function": "function",
        "class": "class",
        "interface": "interface",
        "type": "type",
    }
    for index, token in enumerate(tokens):
        if (
            token.kind == "identifier"
            and index + 4 < len(tokens)
            and tokens[index + 1].value == "."
            and tokens[index + 2].value in {
                "get", "post", "put", "patch", "delete", "options", "head"
            }
            and tokens[index + 3].value == "("
            and tokens[index + 4].kind == "string"
            and tokens[index + 4].value.startswith("/")
            and len(tokens[index + 4].value) <= 200
        ):
            method = tokens[index + 2].value.upper()
            path = tokens[index + 4].value
            symbols.append(RepositorySymbol(
                path=item.path,
                name=f"{method} {path}"[:160],
                kind="route",
                signature=f"{method} {path}"[:512],
                start_line=token.line,
                end_line=tokens[index + 4].line,
            ))
        if token.value in {"import", "require"}:
            for candidate in tokens[index + 1:index + 24]:
                if candidate.kind == "string":
                    edges.append(RepositoryDependency(
                        source=item.path,
                        target=candidate.value,
                        kind="imports",
                    ))
                    break
        kind = declaration_kinds.get(token.value)
        if kind and index + 1 < len(tokens):
            name_token = tokens[index + 1]
            if name_token.kind != "identifier":
                continue
            end_index = min(len(tokens), index + 80)
            signature_tokens: list[str] = []
            for candidate in tokens[index:end_index]:
                if candidate.value in {"{", ";"}:
                    break
                signature_tokens.append(
                    "<literal>"
                    if candidate.kind == "string" else candidate.value
                )
            end_line = max(
                token.line,
                tokens[min(end_index - 1, len(tokens) - 1)].line,
            )
            symbols.append(RepositorySymbol(
                path=item.path,
                name=name_token.value[:160],
                kind=kind,
                signature=" ".join(signature_tokens)[:512],
                start_line=token.line,
                end_line=end_line,
            ))
            if kind in {"class", "interface"}:
                window = tokens[index + 2:index + 30]
                for position, candidate in enumerate(window):
                    if candidate.value in {"extends", "implements"}:
                        target = (
                            window[position + 1].value
                            if position + 1 < len(window) else ""
                        )
                        if target:
                            edges.append(RepositoryDependency(
                                source=f"{item.path}:{name_token.value}",
                                target=target,
                                kind=candidate.value,
                            ))
    return symbols, edges


def _inspect_configuration(
    item: RepositorySourceFile,
    *,
    frameworks: set[str],
    dependencies: dict[str, str],
    tools: dict[str, str],
    capabilities: dict[str, ValidationCapability],
) -> None:
    name = PurePosixPath(item.path).name
    if name == "package.json":
        try:
            payload = json.loads(item.text)
        except (TypeError, ValueError):
            return
        if not isinstance(payload, dict):
            return
        for section in ("dependencies", "devDependencies", "peerDependencies"):
            values = payload.get(section)
            if isinstance(values, dict):
                for dependency, version in values.items():
                    dependency_name = str(dependency)
                    dependency_version = str(version)
                    if (
                        len(dependencies) < 128
                        and re.fullmatch(
                            r"@?[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)?",
                            dependency_name,
                        )
                        and re.fullmatch(
                            r"[~^<>=*0-9A-Za-z.+_-]{1,80}",
                            dependency_version,
                        )
                    ):
                        dependencies[dependency_name[:120]] = (
                            dependency_version[:80]
                        )
        scripts = payload.get("scripts")
        if isinstance(scripts, dict):
            _detect_package_scripts(scripts, capabilities)
        for tool in ("typescript", "eslint", "vite", "vitest", "jest"):
            if tool in dependencies:
                tools[tool] = dependencies[tool]
    elif name == "pyproject.toml":
        try:
            import tomli
            payload = tomli.loads(item.text)
        except (ImportError, TypeError, ValueError):
            return
        project = payload.get("project", {})
        raw_dependencies = (
            project.get("dependencies", [])
            if isinstance(project, dict) else []
        )
        if isinstance(raw_dependencies, list):
            for value in raw_dependencies[:128]:
                match = re.match(
                    r"^\s*([A-Za-z0-9_.-]{1,120})\s*([^;]{0,80})",
                    str(value),
                )
                if match:
                    version = match.group(2).strip()
                    if not version:
                        version = "configured"
                    if re.fullmatch(
                        r"[~^<>=!*0-9A-Za-z.,+_ -]{1,80}", version
                    ):
                        dependencies[match.group(1)] = version
        tool_config = payload.get("tool", {})
        if isinstance(tool_config, dict):
            for tool, check_id, category in (
                ("ruff", "python_lint", "lint"),
                ("mypy", "python_typecheck", "typecheck"),
                ("pyright", "python_typecheck", "typecheck"),
                ("pytest", "python_pytest", "test"),
            ):
                if tool in tool_config:
                    tools.setdefault(tool, "configured")
                    capabilities[check_id] = ValidationCapability(
                        check_id, category, executable=True
                    )
    elif name.startswith("requirements") and name.endswith(".txt"):
        for line in item.text.splitlines()[:500]:
            match = re.fullmatch(
                r"\s*([A-Za-z0-9_.-]{1,120})==([A-Za-z0-9_.+!-]{1,80})\s*",
                line,
            )
            if match and len(dependencies) < 128:
                dependencies[match.group(1)] = match.group(2)
        if "pytest" in dependencies:
            capabilities["python_pytest"] = ValidationCapability(
                "python_pytest", "test", executable=True
            )
        for tool, check_id, category in (
            ("ruff", "python_lint", "lint"),
            ("mypy", "python_typecheck", "typecheck"),
            ("pyright", "python_typecheck", "typecheck"),
        ):
            if tool in dependencies:
                tools[tool] = dependencies[tool]
                capabilities[check_id] = ValidationCapability(
                    check_id, category, executable=True
                )


def _detect_package_scripts(
    scripts: dict[object, object],
    capabilities: dict[str, ValidationCapability],
) -> None:
    # Script bodies are trusted project configuration, but are never returned
    # to a model or validator. Only recognized capability IDs cross boundaries.
    mapping = {
        "lint": ("typescript_lint", "lint"),
        "typecheck": ("typescript_typecheck", "typecheck"),
        "test": ("typescript_tests", "test"),
        "build": ("typescript_build", "build"),
    }
    for name, (check_id, category) in mapping.items():
        body = scripts.get(name)
        if not isinstance(body, str):
            continue
        allowed_prefixes = {
            "lint": ("eslint ", "eslint."),
            "typecheck": ("tsc ", "tsc-", "npm run "),
            "test": ("vitest ", "jest ", "npm run "),
            "build": ("vite build", "tsc ", "npm run "),
        }[name]
        normalized = body.strip().lower()
        if normalized.startswith(allowed_prefixes):
            capabilities[check_id] = ValidationCapability(
                check_id, category, executable=True
            )


def _detect_frameworks(
    files: tuple[RepositorySourceFile, ...],
    symbols: list[RepositorySymbol],
    frameworks: set[str],
) -> None:
    dependencies = "\n".join(
        item.text[:50_000]
        for item in files
        if PurePosixPath(item.path).name in {
            "package.json", "requirements.txt", "pyproject.toml",
        }
    ).casefold()
    for needle, framework in (
        ("fastapi", "fastapi"),
        ("django", "django"),
        ("flask", "flask"),
        ('"react"', "react"),
        ('"next"', "nextjs"),
        ('"vue"', "vue"),
        ("sqlmodel", "sqlmodel"),
        ("sqlalchemy", "sqlalchemy"),
    ):
        if needle in dependencies:
            frameworks.add(framework)
    if any(symbol.kind == "route" for symbol in symbols):
        frameworks.add("http-api")
    if any(symbol.kind == "model" for symbol in symbols):
        frameworks.add("database-models")
