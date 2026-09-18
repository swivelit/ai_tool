"""Actual shell control flow with fixture host/tool facts, NOT native inference.

No production test-mode/skip switch: only the temporary copy's OS probes are
substituted. Every test runs the unchanged shell orchestration through /bin/bash.
"""
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS=Path(__file__).resolve().parents[1]/"scripts"


@pytest.fixture
def setup_tree(tmp_path):
    repo=tmp_path/"repo with spaces & punctuation"
    scripts=repo/"swico_video_node/scripts"
    scripts.mkdir(parents=True)
    tools=tmp_path/"native tools with spaces";tools.mkdir()
    clt=tmp_path/"CommandLineTools";clt.mkdir()
    user_dir=tmp_path/"user home";user_dir.mkdir()
    environment={"PATH":"/usr/bin:/bin", "HOME":str(user_dir), "FIXTURE_TOOLS":str(tools),
                 "FIXTURE_CLT":str(clt), "FIXTURE_SYSTEM":"Darwin", "FIXTURE_ARCH":"x86_64",
                 "FIXTURE_OS":"26.7", "FIXTURE_TRANSLATED":"0", "FIXTURE_PYTHON_ID":"3.12|Darwin|x86_64",
                 "FIXTURE_TOOL_ARCH":"Mach-O 64-bit executable x86_64", "FIXTURE_REAL_PYTHON":sys.executable,
                 "FIXTURE_BOOTSTRAP_LOG":str(tmp_path/"bootstrap.log")}
    (scripts/"setup_macos.sh").write_text((SCRIPTS/"setup_macos.sh").read_text())
    (scripts/"prerequisites_macos.sh").write_text((SCRIPTS/"prerequisites_macos.sh").read_text()+r'''
# Fixture-only OS/discovery seams. Not present in production scripts.
video_system() { printf '%s\n' "$FIXTURE_SYSTEM"; }
video_machine() { printf '%s\n' "$FIXTURE_ARCH"; }
video_os_version() { printf '%s\n' "$FIXTURE_OS"; }
video_translated() { printf '%s\n' "$FIXTURE_TRANSLATED"; }
video_clt() { printf '%s\n' "$FIXTURE_CLT"; }
video_port_path() { printf '%s/port\n' "$FIXTURE_TOOLS"; }
video_default_python() { if [[ -f "$FIXTURE_TOOLS/python3.12" ]]; then printf '%s/python3.12\n' "$FIXTURE_TOOLS"; fi; }
video_default_tool() { if [[ -f "$FIXTURE_TOOLS/$1" ]]; then printf '%s/%s\n' "$FIXTURE_TOOLS" "$1"; fi; }
video_binary_arch() { printf '%s\n' "$FIXTURE_TOOL_ARCH"; }
''')
    python=tools/"python3.12"
    python.write_text(r'''#!/bin/bash
if [[ "$1" == -I && "$5" == import\ platform,sys* ]]; then
  printf '%s\n' "$FIXTURE_PYTHON_ID"
elif [[ "$1" == -I ]]; then
  exec "$FIXTURE_REAL_PYTHON" "$@"
elif [[ "$1" == -m && "$2" == swico_video_node.bootstrap ]]; then
  printf '%s\n' "$@" > "$FIXTURE_BOOTSTRAP_LOG"
  exit "${FIXTURE_BOOTSTRAP_STATUS:-0}"
else exit 90; fi
''');python.chmod(0o700)
    for name in ("ffmpeg","ffprobe"):
        (tools/name).write_text("#!/bin/sh\nexit 99\n");(tools/name).chmod(0o700)
    def run(*args, **overrides):
        return subprocess.run(["/bin/bash",str(scripts/"setup_macos.sh"),*args],env={**environment,**overrides},capture_output=True,text=True,timeout=15)
    return repo,tools,user_dir,environment,run


def snapshot(directory):
    return {str(p.relative_to(directory)):(p.read_bytes(),p.stat().st_mode,p.stat().st_mtime_ns)
            for p in directory.rglob("*") if p.is_file()}


def test_no_python_macports_or_codecs_reports_each_without_worker_import(setup_tree):
    repo,tools,user_dir,env,run=setup_tree
    for item in tools.iterdir():item.unlink()
    before=snapshot(repo.parent)
    for args in (("--check",),()):
        result=run(*args)
        assert result.returncode==1, result.stderr
        for marker in ("macos_major=26","macports=missing_or_incomplete","python=missing_or_not_executable","ffmpeg=missing","ffprobe=missing","prerequisites=blocked"):
            assert marker in result.stdout
        assert "does NOT download or install" in result.stdout and "PATH does NOT install" in result.stdout
        assert "selfupdate is NOT the first" in result.stdout
        assert "Traceback" not in result.stderr
    assert snapshot(repo.parent)==before
    assert not Path(env["FIXTURE_BOOTSTRAP_LOG"]).exists()


def test_check_is_repeatable_read_only_with_alternative_native_tools_and_no_port(setup_tree):
    repo,tools,user_dir,env,run=setup_tree
    # Existing partial install and credential sentinel must remain byte/mode/time identical.
    incomplete=repo/".venv-video";incomplete.mkdir();(incomplete/"inspect-me").write_text("partial install")
    private=user_dir/"Library/Application Support/SwicoVideo";private.mkdir(parents=True)
    (private/"worker.token").write_text("never-read-or-log-fixture-token")
    before=snapshot(repo.parent)
    first=run("--check","--python",str(tools/"python3.12"))
    second=run("--python",str(tools/"python3.12"),"--check")
    assert first.returncode==second.returncode==0,first.stderr
    assert first.stdout==second.stdout
    assert "prerequisites=present" in first.stdout and "macports=missing_or_incomplete" in first.stdout
    assert "codec_smoke=not_run" in first.stdout and "never-read" not in first.stdout
    assert snapshot(repo.parent)==before


@pytest.mark.parametrize("variable,value,marker",[
    ("FIXTURE_SYSTEM","Linux","platform=unsupported"),
    ("FIXTURE_ARCH","arm64","platform=unsupported"),
    ("FIXTURE_TRANSLATED","1","platform=translated_process"),
    ("FIXTURE_CLT","/missing-clt-fixture","command_line_tools=missing"),
    ("FIXTURE_PYTHON_ID","3.13|Darwin|x86_64","python=wrong_version"),
    ("FIXTURE_PYTHON_ID","3.12|Darwin|arm64","python=wrong_architecture_or_platform"),
    ("FIXTURE_PYTHON_ID","","python=identity_check_failed"),
    ("FIXTURE_TOOL_ARCH","Mach-O arm64","ffmpeg=wrong_architecture"),
])
def test_failed_prerequisite_never_enters_bootstrap(setup_tree,variable,value,marker):
    repo,tools,user_dir,env,run=setup_tree
    result=run(**{variable:value})
    assert result.returncode==1 and marker in result.stdout,result.stdout+result.stderr
    assert not Path(env["FIXTURE_BOOTSTRAP_LOG"]).exists()
    assert not (repo/".venv-video").exists()


@pytest.mark.parametrize("name",["ffmpeg","ffprobe"])
def test_independent_missing_and_nonexecutable_codec_stops_setup(setup_tree,name):
    repo,tools,user_dir,env,run=setup_tree
    (tools/name).chmod(0o600)
    assert name+"=not_absolute_or_not_executable" in run().stdout
    (tools/name).unlink()
    result=run()
    assert result.returncode==1 and name+"=missing" in result.stdout
    assert not Path(env["FIXTURE_BOOTSTRAP_LOG"]).exists()


def test_incomplete_macports_install_rechecks_successfully_without_installing(setup_tree):
    repo,tools,user_dir,env,run=setup_tree
    (tools/"port").write_text("partial installer")
    assert "macports=missing_or_incomplete" in run("--check").stdout
    (tools/"port").chmod(0o700)
    result=run("--check")
    assert result.returncode==0 and "macports=present" in result.stdout
    # The malformed fixture port executable was inspected, NOT executed.
    assert not Path(env["FIXTURE_BOOTSTRAP_LOG"]).exists()


def test_shell_normal_setup_routes_absolute_python_and_propagates_bootstrap_failure(setup_tree):
    repo,tools,user_dir,env,run=setup_tree
    result=run("--python",str(tools/"python3.12"))
    assert result.returncode==0,result.stderr
    assert Path(env["FIXTURE_BOOTSTRAP_LOG"]).read_text()=="-m\nswico_video_node.bootstrap\n"
    result=run(FIXTURE_BOOTSTRAP_STATUS="19")
    assert result.returncode==19  # No pip/codec/import failure is converted to success.


def test_read_only_configured_tool_paths_preserve_alternatives(setup_tree,tmp_path):
    repo,tools,user_dir,env,run=setup_tree
    state=tmp_path/"reviewed state";state.mkdir()
    configured={}
    for name in ("ffmpeg","ffprobe"):
        destination=tmp_path/("reviewed "+name)
        (tools/name).rename(destination)
        configured[name]={"path":str(destination)}
    config=state/"runtime-tools.json";config.write_text(json.dumps({"schema":1,"tools":configured}))
    before=config.read_bytes()
    result=run("--check",SWICO_VIDEO_DATA_DIR=str(state))
    assert result.returncode==0,result.stdout+result.stderr
    assert "ffmpeg=present_native_binary" in result.stdout
    config.write_text("interrupted write fixture")
    result=run("--check",SWICO_VIDEO_DATA_DIR=str(state))
    assert result.returncode==1 and "invalid_tool_configuration" in result.stdout
    assert config.read_text()=="interrupted write fixture" and before


def test_check_resolves_relative_state_from_same_repo_as_bootstrap(setup_tree):
    repo,tools,user_dir,env,run=setup_tree
    state=repo/"relative state";state.mkdir()
    (state/"runtime-tools.json").write_text('{"schema":1,"tools":{}}')
    result=run("--check",SWICO_VIDEO_DATA_DIR="relative state")
    assert result.returncode==1 and "invalid_tool_configuration" in result.stdout
    assert not Path(env["FIXTURE_BOOTSTRAP_LOG"]).exists()


@pytest.mark.parametrize("args",[("--python",),("--python","relative"),("--bogus",),("--check","--python","/one","--python","/two")])
def test_invalid_arguments_never_enter_bootstrap(setup_tree,args):
    repo,tools,user_dir,env,run=setup_tree
    assert run(*args).returncode==2
    assert not Path(env["FIXTURE_BOOTSTRAP_LOG"]).exists()


def test_check_does_not_require_external_developer_dependencies():
    source=(SCRIPTS/"prerequisites_macos.sh").read_text()
    assert '/usr/bin/file -L -b "$1"' in source  # Supported bin symlinks resolve.
    for forbidden in ("sudo ","curl ","brew ","-m swico_video_node", "mkdir ","mktemp "):
        assert forbidden not in source
    assert "-I -S -B" in source  # No site packages or bytecode writes.


def installer_block():
    document=(SCRIPTS.parents[1]/"docs/VIDEO_MAC_SETUP.md").read_text()
    section=document.split("<!-- macports-tahoe-install:begin -->",1)[1].split("<!-- macports-tahoe-install:end -->",1)[0]
    return re.search(r"```bash\n(.*?)\n```",section,re.S).group(1)


@pytest.fixture
def installer_fixture(tmp_path):
    # EXACT documented flow, replacing ONLY external command paths with inert
    # fixtures. No installer/download/privilege action is real.
    commands=tmp_path/"commands with spaces & metacharacters";commands.mkdir()
    user_dir=tmp_path/"operator home";user_dir.mkdir()
    log=tmp_path/"calls.log"
    port=commands/"port"
    scripts={
        "/usr/bin/uname":'if [ "$1" = -s ]; then printf "%s\\n" "${FIXTURE_SYSTEM:-Darwin}"; else printf "%s\\n" x86_64; fi',
        "/usr/bin/sw_vers":'printf "%s\\n" "${FIXTURE_VERSION:-26.7}"',
        "/usr/sbin/sysctl":'printf "%s\\n" "${FIXTURE_TRANSLATED:-0}"',
        "/usr/bin/xcode-select":'exit "${FIXTURE_CLT_FAILURE:-0}"',
        "/usr/bin/curl":'''printf 'curl\\n' >> "$FIXTURE_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then shift; fixture_output="$1"; fi
  shift
done
printf 'not a real installer' > "$fixture_output"
exit "${FIXTURE_DOWNLOAD_FAILURE:-0}"''',
        "/usr/bin/shasum":'''printf 'checksum\\n' >> "$FIXTURE_LOG"
IFS= read -r fixture_line
case "$fixture_line" in
  'ddd90723ba470a688296bb520335e1c7c08835d82df4141e6807b411bc8b78e8  MacPorts-2.12.6-26-Tahoe.pkg') exit "${FIXTURE_HASH_FAILURE:-0}" ;;
  *) exit 91 ;;
esac''',
        "/usr/bin/sudo":'''printf 'sudo\\n' >> "$FIXTURE_LOG"
exec "$@"''',
        "/usr/sbin/installer":'''printf 'installer\\n' >> "$FIXTURE_LOG"
[ "${FIXTURE_INSTALL_FAILURE:-0}" = 0 ] || exit "$FIXTURE_INSTALL_FAILURE"
[ "$1" = -pkg ] && [ -f "$2" ] && [ "$3" = -target ] && [ "$4" = / ] || exit 92
if [ "${FIXTURE_MISSING_PORT:-0}" = 0 ]; then
  printf '#!/bin/sh\\nprintf "port\\\\n" >> "$FIXTURE_LOG"\\nprintf "Version: 2.12.6\\\\n"\\n' > "$FIXTURE_PORT"
  chmod 700 "$FIXTURE_PORT"
fi''',
    }
    block=installer_block()
    for original,body in scripts.items():
        target=commands/Path(original).name
        target.write_text("#!/bin/sh\nset -eu\n"+body+"\n");target.chmod(0o700)
        assert original in block
        block=block.replace(original,shlex.quote(str(target)))
    block=block.replace("/opt/local/bin/port",shlex.quote(str(port)))
    env={"PATH":"/usr/bin:/bin","HOME":str(user_dir),"FIXTURE_LOG":str(log),"FIXTURE_PORT":str(port)}
    def run(**extra):
        return subprocess.run(["/bin/bash","-c",block],env={**env,**extra},capture_output=True,text=True,timeout=15)
    return run,log,port,user_dir,commands


def test_documented_installer_is_pinned_and_https_only():
    block=installer_block()
    assert "https://github.com/macports/macports-base/releases/download/v2.12.6/MacPorts-2.12.6-26-Tahoe.pkg" in block
    assert "--proto '=https' --proto-redir '=https'" in block
    assert block.index("/usr/bin/shasum")<block.index("/usr/bin/sudo")<block.index("[ -x /opt/local/bin/port ]",block.index("/usr/bin/sudo"))
    assert "set -eu" in block and "--insecure" not in block
    assert subprocess.run(["/bin/bash","-n"],input=block,text=True,capture_output=True).returncode==0


def test_documented_install_checks_hash_before_privilege_and_is_repeatable(installer_fixture):
    run,log,port,user_dir,commands=installer_fixture
    result=run()
    assert result.returncode==0,result.stderr
    assert "Version: 2.12.6" in result.stdout
    assert log.read_text().splitlines()==["curl","checksum","sudo","installer","port"]
    downloads=list((user_dir/"Downloads").iterdir())
    assert len(downloads)==1 and downloads[0].stat().st_mode&0o077==0
    assert run().returncode==0
    assert log.read_text().splitlines()==["curl","checksum","sudo","installer","port","port"]
    assert list((user_dir/"Downloads").iterdir())==downloads


@pytest.mark.parametrize("variable,value,expected",[
    ("FIXTURE_SYSTEM","Linux",[]),
    ("FIXTURE_VERSION","27.0",[]),
    ("FIXTURE_TRANSLATED","1",[]),
    ("FIXTURE_CLT_FAILURE","2",[]),
    ("FIXTURE_DOWNLOAD_FAILURE","22",["curl"]),
    ("FIXTURE_DOWNLOAD_FAILURE","130",["curl"]),
    ("FIXTURE_HASH_FAILURE","1",["curl","checksum"]),
    ("FIXTURE_INSTALL_FAILURE","1",["curl","checksum","sudo","installer"]),
    ("FIXTURE_MISSING_PORT","1",["curl","checksum","sudo","installer"]),
])
def test_documented_install_stops_at_each_failed_checkpoint(installer_fixture,variable,value,expected):
    run,log,port,user_dir,commands=installer_fixture
    result=run(**{variable:value})
    assert result.returncode!=0
    assert (log.read_text().splitlines() if log.exists() else [])==expected
    assert not port.exists()


def test_actual_checksum_rejects_wrong_fixture_bytes_before_privilege(installer_fixture):
    run,log,port,user_dir,commands=installer_fixture
    checksum=commands/"shasum"
    checksum.write_text('#!/bin/sh\nexec /usr/bin/shasum "$@"\n')
    result=run()
    assert result.returncode!=0 and "FAILED" in result.stdout
    assert log.read_text().splitlines()==["curl"] and not port.exists()
