import json
import os
import subprocess
import sys
import time
from pathlib import Path
import pytest
from swico_video_node import __main__ as command
from swico_video_node import models, storage, worker


@pytest.fixture
def local(tmp_path,monkeypatch):
    monkeypatch.setenv("SWICO_VIDEO_DATA_DIR",str(tmp_path/"node"))
    return tmp_path/"node"


@pytest.mark.parametrize("arguments",[
    ["--help"],["init","--help"],["models","audit","--help"],["models","install","--help"],
    ["templates","import","--help"],["templates","prepare","--help"],["templates","review","--help"],
    ["templates","publish","--help"],["benchmark","--help"],["doctor","--help"],["run","--help"],
    ["service","--help"],["rotate-token","--help"],
])
def test_required_runnable_commands(arguments):
    result=subprocess.run([sys.executable,"-m","swico_video_node",*arguments],capture_output=True,text=True,timeout=10)
    assert result.returncode==0,result.stderr
    assert "usage:" in result.stdout


def test_init_digest_only_no_overwrite_and_mode(local,capsys):
    storage.init("intel-mac-01","https://ai-tool-rrau.onrender.com")
    token=(local/"worker.token").read_bytes()
    assert capsys.readouterr().out.strip()==storage.digest(token)
    assert len(token)>=64
    assert (local/"worker.token").stat().st_mode & 0o077 == 0
    storage.init("intel-mac-01","https://ai-tool-rrau.onrender.com")
    assert (local/"worker.token").read_bytes()==token
    assert json.loads((local/"models.json").read_text())["engine_commit"]==storage.ENGINE_COMMIT
    with pytest.raises(ValueError):models.audit(require_files=False)


@pytest.mark.parametrize("url",["http://example.com","https://user:pass@example.com","https://example.com/path","https://example.com?secret=value"])
def test_init_rejects_unsafe_origins(local,url):
    with pytest.raises(ValueError):storage.init("intel-mac-01",url)


def test_modified_rights_invalidates_review(local):
    storage.init("intel-mac-01","https://example.com")
    for name in ("permission","licence"):
        (local/"rights"/(name+".txt")).write_text("Test fixture document, not commercial permission.")
    record={"reviewer":"test","reviewed_at":"2026-09-18"}
    for name in ("permission","licence"):
        record[name+"_file"]=name+".txt";record[name+"_sha256"]=storage.hash_file(local/"rights"/(name+".txt"))
    models.evidence(record)
    (local/"rights/permission.txt").write_text("changed")
    with pytest.raises(ValueError):models.evidence(record)


def test_symlink_confinement_and_cleanup(local,tmp_path):
    storage.init("intel-mac-01","https://example.com")
    outside=tmp_path/"outside";outside.mkdir();(outside/"keep").write_text("keep")
    link=local/"jobs/12345678-1234-1234-1234-123456789abc";link.symlink_to(outside)
    with pytest.raises(ValueError):storage.cleanup_jobs()
    assert (outside/"keep").exists()


def test_caption_does_not_become_filter_expression():
    from swico_video_node.engine import Engine
    Engine.caption("50%: 'quote'; [not a filter]")
    with pytest.raises(ValueError):Engine.caption("unsupported\nnew line")
    with pytest.raises(ValueError):Engine.caption("\x00")


def test_runtime_rejects_wrong_python_abi(monkeypatch):
    from swico_video_node import engine
    monkeypatch.setattr(engine.sys,"version_info",(3,14,0))
    with pytest.raises(ValueError, match="Python 3.12"):engine.runtime_identity()


def test_rotation_changes_only_digest_and_private_token(local,capsys):
    storage.init("intel-mac-01","https://example.com")
    capsys.readouterr()
    original=(local/"worker.token").read_bytes()
    storage.rotate_token()
    updated=(local/"worker.token").read_bytes()
    assert original!=updated
    assert capsys.readouterr().out.strip()==storage.digest(updated)
    assert (local/"worker.token").stat().st_mode & 0o077 == 0


@pytest.mark.skipif(os.name=="nt",reason="Worker supports Intel macOS only")
def test_process_group_escalation(tmp_path):
    import signal
    process=subprocess.Popen([sys.executable,"-c","import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)"],start_new_session=True)
    try:
        time.sleep(.15)
        worker.terminate_tree(process)
        assert process.poll() is not None
        with pytest.raises(ProcessLookupError):os.killpg(process.pid,0)
    finally:
        if process.poll() is None:process.kill();process.wait()


@pytest.mark.skipif(os.name=="nt",reason="Worker supports Intel macOS only")
def test_cancellation_kills_descendant_even_when_parent_exits_first(tmp_path):
    pid_file=tmp_path/"descendant.pid"
    child="import os,signal,time,pathlib,sys; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)"
    parent="import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2]]); time.sleep(30)"
    process=subprocess.Popen([sys.executable,"-c",parent,child,str(pid_file)],start_new_session=True)
    try:
        for _ in range(100):
            if pid_file.exists():break
            time.sleep(.02)
        assert pid_file.exists(),"Descendant did not start"
        child_pid=int(pid_file.read_text())
        worker.terminate_tree(process)
        assert process.poll() is not None
        for _ in range(100):
            state=subprocess.run(["ps","-o","stat=","-p",str(child_pid)],capture_output=True,text=True).stdout.strip()
            if not state or state.startswith("Z"):break
            time.sleep(.02)
        assert not state or state.startswith("Z"),"Descendant remains live after cancellation"
    finally:
        worker.terminate_tree(process)


@pytest.mark.skipif(os.name=="nt",reason="Worker supports Intel macOS only")
def test_supervisor_death_pipe_kills_native_child_group_and_holds_lock(tmp_path):
    import fcntl
    import signal
    read_fd,write_fd=os.pipe()
    ready=tmp_path/"ready"
    lock=(tmp_path/"worker.lock").open("a+")
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    code="from swico_video_node.worker import guard_parent; import pathlib,sys,time,signal; guard_parent(int(sys.argv[1])); signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(sys.argv[2]).touch(); time.sleep(30)"
    process=subprocess.Popen([sys.executable,"-c",code,str(read_fd),str(ready)],pass_fds=(read_fd,lock.fileno()),start_new_session=True)
    os.close(read_fd)
    try:
        for _ in range(100):
            if ready.exists():break
            time.sleep(.02)
        assert ready.exists()
        lock.close()  # Simulate losing the parent; child still owns the same flock.
        with (tmp_path/"worker.lock").open("a+") as replacement:
            with pytest.raises(BlockingIOError):fcntl.flock(replacement,fcntl.LOCK_EX|fcntl.LOCK_NB)
            os.close(write_fd);write_fd=None
            assert process.wait(timeout=5)==-signal.SIGKILL
            fcntl.flock(replacement,fcntl.LOCK_EX|fcntl.LOCK_NB)
    finally:
        if write_fd is not None:os.close(write_fd)
        worker.terminate_tree(process)
        lock.close()
