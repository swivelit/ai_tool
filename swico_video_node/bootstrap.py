"""Resumable operator-only Intel bootstrap; never loads/downloads model weights."""
import importlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from .storage import ENGINE_COMMIT, atomic, exclusive, root, hash_file
from .engine_status import status as engine_status
from .runtime import native_host, configure_tools, minimal_environment, safe_error, tools, encode_smoke

REPO = Path(__file__).resolve().parents[1]
PIP = "pip==25.2"


def execute(args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, timeout=kwargs.pop("timeout",600), **kwargs)


def python_identity(python):
    result = subprocess.run([str(python), "-I", "-c", "import sys,platform,json; print(json.dumps({'version':list(sys.version_info[:3]),'machine':platform.machine(),'system':platform.system(),'base':sys.base_prefix,'prefix':sys.prefix}))"],
                            capture_output=True,text=True,check=True,timeout=15)
    return json.loads(result.stdout)


def validate_python(info):
    if info["version"][:2] != [3,12] or info["system"]!="Darwin" or info["machine"]!="x86_64":
        raise ValueError("Requires native Intel Darwin Python 3.12; selected interpreter incompatible")


def environment(base, destination):
    expected=python_identity(base);validate_python(expected)
    python=destination/"bin/python"
    if destination.exists():
        if not python.exists(): raise ValueError("Incomplete .venv-video: inspect/archive explicitly; it was not overwritten")
        current=python_identity(python);validate_python(current)
        if current["base"]!=expected["base"] or current["version"]!=expected["version"] or current["base"]==current["prefix"]:
            raise ValueError("Incompatible existing .venv-video; stop service and archive explicitly before recreating")
    else:
        # MacPorts disables bundled ensurepip. py312-pip manages a pip-less venv
        # via supported --python. No sudo/global interpreter write.
        execute([base,"-m","venv","--without-pip",destination])
    result=subprocess.run([python,"-m","pip","--version"],capture_output=True,timeout=20)
    if result.returncode:
        base_pip=subprocess.run([base,"-m","pip","--version"],capture_output=True,timeout=20)
        if base_pip.returncode: raise ValueError("pip unavailable: install MacPorts py312-pip; never use sudo pip")
        execute([base,"-m","pip","--python",python,"install","--only-binary=:all:",PIP])
    execute([python,"-m","pip","--version"])
    return python


def engine_checkout():
    directory=root()/"engine/facefusion"
    directory.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    current = engine_status()
    if current["state"] == "ready":
        return directory
    empty_bootstrap_directory = current["state"] == "not_repository" and directory.is_dir() and not any(directory.iterdir())
    if current["state"] not in {"missing"} and not empty_bootstrap_directory:
        raise ValueError("Unexpected engine directory: inspect/archive explicitly; never adopting it")
    if not directory.exists() or empty_bootstrap_directory: execute(["git","init",directory])
    commit=subprocess.run(["git","-C",directory,"rev-parse","HEAD"],capture_output=True,text=True,timeout=10)
    dirty=subprocess.check_output(["git","-C",directory,"status","--porcelain","--untracked-files=all"],text=True,timeout=10)
    if dirty or (commit.returncode==0 and commit.stdout.strip()!=ENGINE_COMMIT):
        raise ValueError("Dirty/wrong engine checkout; inspect/archive explicitly, no reset performed")
    if commit.returncode:
        execute(["git","-C",directory,"fetch","--depth","1","https://github.com/facefusion/facefusion.git",ENGINE_COMMIT])
        execute(["git","-C",directory,"checkout","--detach",ENGINE_COMMIT])
    actual=subprocess.check_output(["git","-C",directory,"rev-parse","HEAD"],text=True).strip()
    if actual!=ENGINE_COMMIT: raise ValueError("Pinned engine revision mismatch")
    return directory


def smoke():
    # Full used headless transitive import path, no pre_check/download/Engine.
    sys.path.insert(0,str(root()/"engine/facefusion"))
    for name in ("face_detector","face_landmarker","face_recognizer","face_masker","content_analyser",
                 "processors.modules.face_swapper","processors.modules.face_enhancer"):
        importlib.import_module("facefusion."+name)
    from .engine import runtime_identity
    runtime_identity()
    import onnxruntime
    if "CPUExecutionProvider" not in onnxruntime.get_available_providers(): raise ValueError("CPU provider missing")
    print(json.dumps({"dependency_import_smoke":True,"native_model_inference":"not_run"}))


def install_dependencies(python):
    with tempfile.TemporaryDirectory(prefix="swico-video-wheels-") as temporary:
        wheels=Path(temporary)
        try:
            execute([python,"-m","pip","download","--only-binary=:all:","-r",REPO/"swico_video_node/requirements-intel.lock","-d",wheels])
        except subprocess.CalledProcessError:
            raise ValueError("Locked Intel/Python3.12 wheel resolution failed; see pip's exact missing distribution; no source-build fallback") from None
        execute([python,"-m","pip","install","--no-index","--find-links",wheels,"--only-binary=:all:","-r",REPO/"swico_video_node/requirements-intel.lock"])
        atomic(root()/"dependency-wheels.json",{p.name:hash_file(p) for p in wheels.glob("*.whl")})
    execute([python,"-m","pip","check"])


def main():
    os.umask(0o077)
    if sys.argv[1:]==["--smoke"]: smoke();return
    native_host();validate_python(python_identity(sys.executable))
    print(json.dumps({"category":"prerequisites","interpreter":sys.executable,"architecture":"x86_64"}))
    execute(["/usr/bin/xcode-select","-p"])
    if (root()/"runtime-tools.json").exists():
        # Never silently repin an operator-selected or replaced tool on re-setup.
        encode_smoke(tools())
    else: configure_tools()
    with exclusive():
        current_engine = engine_status()
        empty_engine_directory = current_engine["state"] == "not_repository" and not any((root()/"engine/facefusion").iterdir())
        if current_engine["state"] not in {"ready", "missing"} and not empty_engine_directory:
            raise ValueError("Engine checkout is not valid; run engine status and explicit engine recover before dependency installation")
        python=environment(sys.executable,REPO/".venv-video")
        install_dependencies(python)
        engine_checkout()
        execute([python,"-m","swico_video_node.bootstrap","--smoke"],env=minimal_environment(),cwd=REPO)
    print(json.dumps({"dependency_import_smoke":True,"model_files_and_permissions":"required: models audit",
                      "template_review":"required","native_calibration":"required","api_authentication":"doctor --check-api"}))


if __name__=="__main__":
    try: main()
    except Exception as exc:
        print(json.dumps({"ready":False,"category":"bootstrap", "error":str(exc)[:300] if isinstance(exc,ValueError) else safe_error(exc,"bootstrap")}),file=sys.stderr)
        sys.exit(1)
