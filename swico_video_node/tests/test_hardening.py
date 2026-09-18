"""Contract/mock platform tests; never labelled native model acceptance."""
import copy
import json
import os
import plistlib
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
from pathlib import Path
from types import SimpleNamespace
import pytest
from swico_video_node import bootstrap, calibration, diagnostics, models, runtime, service, storage, worker


@pytest.fixture
def local(tmp_path,monkeypatch,capsys):
    monkeypatch.setenv("SWICO_VIDEO_DATA_DIR",str(tmp_path/"private node"))
    storage.init("intel-mac-01","https://example.invalid")
    capsys.readouterr()
    return storage.root()


def test_doctor_auth_is_independent_of_missing_native_assets(local,monkeypatch):
    calls=[]
    monkeypatch.setattr(worker.Api,"request",lambda self,*args: calls.append(args) or {
        "authenticated":True,"schema_ready":True,"control_initialized":False,"worker_active":False,"templates_current":False})
    result=diagnostics.doctor(True)
    assert calls==[("GET","/health")]
    assert result["checks"]["api"]["authenticated"] is True
    assert not result["ready"] and not result["native_inference_verified"]
    assert (local/"worker.token").read_text() not in json.dumps(result)
    assert result["checks"]["models"]["items"] and len(result["checks"]["models"]["items"])==10


@pytest.mark.parametrize("error,status",[
    (urllib.error.HTTPError("https://example.invalid",401,"secret",{},None),"credential_mismatch"),
    (urllib.error.HTTPError("https://example.invalid",403,"secret",{},None),"credential_forbidden"),
    (urllib.error.HTTPError("https://example.invalid",404,"secret",{},None),"api_not_deployed"),
    (urllib.error.HTTPError("https://example.invalid",503,"secret",{},None),"http_error"),
    (urllib.error.URLError(socket.gaierror("secret")),"dns_failure"),
    (urllib.error.URLError(TimeoutError("secret")),"network_timeout"),
    (urllib.error.URLError(ConnectionRefusedError("secret")),"connect_failure"),
    (urllib.error.URLError(ssl.SSLError("secret")),"tls_failure"),
    (TimeoutError("secret"),"network_timeout"),
    (json.JSONDecodeError("secret","",0),"response_contract_error"),
    (ValueError("secret redirect"),"local_configuration_or_redirect_refused"),
])
def test_pairing_errors_are_classified_without_secret(local,monkeypatch,error,status):
    def request(*args):raise error
    monkeypatch.setattr(worker.Api,"request",request)
    result=diagnostics.api_check()
    assert result["status"]==status and "secret" not in json.dumps(result)


def test_pairing_response_contract_and_redirect(local,monkeypatch):
    monkeypatch.setattr(worker.Api,"request",lambda *a:{"authenticated":True,"schema_ready":"yes"})
    assert diagnostics.api_check()["status"]=="response_contract_error"
    with pytest.raises(ValueError,match="redirects"):worker.NoRedirect().redirect_request(None,None,None,None,None,None)


def test_sanitized_child_uses_macports_tools_not_parent_secrets(local,monkeypatch):
    monkeypatch.setenv("PROVIDER_API_KEY","never-inherit")
    monkeypatch.setenv("PATH",".:/evil")
    monkeypatch.setattr(worker,"tools",lambda:{"ffmpeg":{"path":"/opt/local/bin/ffmpeg"}})
    value=worker.child_environment(19)
    assert value=={**runtime.minimal_environment(),"SWICO_VIDEO_PARENT_FD":"19"}
    assert value["PATH"].startswith("/opt/local/bin:")
    assert "never-inherit" not in json.dumps(value)
    assert "/evil" not in value["PATH"] and "worker.token" not in json.dumps(value)


def mock_tools(local,monkeypatch):
    directory=local/"tools with spaces";directory.mkdir()
    for name in ("ffmpeg","ffprobe"):
        path=directory/name;path.write_bytes(b"binary fixture");path.chmod(0o700)
    monkeypatch.setattr(runtime,"SEARCH",(str(directory),))
    def capture(args,**kw):
        if args[0]=="/usr/bin/file":return "Mach-O 64-bit executable x86_64"
        if args[0]=="/usr/bin/otool":return "fixture:\n /usr/lib/libSystem.B.dylib (compatibility version 1.0)\n"
        return Path(args[0]).name+" version fixture\nconfiguration reviewed fixture"
    monkeypatch.setattr(runtime,"capture",capture)
    return directory


def test_tool_identity_path_space_minimal_discovery_and_replacement(local,monkeypatch):
    directory=mock_tools(local,monkeypatch)
    selected=runtime.tools()
    assert selected["ffmpeg"]["path"]==str(directory/"ffmpeg")
    storage.atomic(local/"runtime-tools.json",{"schema":1,"tools":selected})
    assert runtime.tool("ffprobe")==str(directory/"ffprobe")
    (directory/"ffmpeg").write_bytes(b"replacement")
    with pytest.raises(ValueError,match="replaced"):runtime.tools()


@pytest.mark.parametrize("name",["ffmpeg","ffprobe"])
def test_missing_or_nonexecutable_tools_distinct(local,monkeypatch,name):
    directory=mock_tools(local,monkeypatch)
    (directory/name).chmod(0o600)
    with pytest.raises(ValueError,match=name+": not an executable"):runtime.tools()
    (directory/name).unlink()
    with pytest.raises(ValueError,match=name+": missing"):runtime.tools()


def test_tool_relative_and_wrong_architecture_rejected(local,monkeypatch):
    directory=mock_tools(local,monkeypatch)
    with pytest.raises(ValueError,match="absolute"):runtime.inspect_tool("ffmpeg","./ffmpeg")
    monkeypatch.setattr(runtime,"capture",lambda *a,**k:"Mach-O arm64")
    with pytest.raises(ValueError,match="x86_64"):runtime.inspect_tool("ffmpeg",str(directory/"ffmpeg"))


def test_encode_decode_smoke_is_real_command_contract_and_failure(local,monkeypatch):
    calls=[]
    def capture(argv,**kwargs):
        calls.append(argv)
        return '{"streams":[{"codec_name":"h264"}]}' if argv[0]=="/opt/local/bin/ffprobe" else ""
    monkeypatch.setattr(runtime,"capture",capture)
    selected={n:{"path":"/opt/local/bin/"+n} for n in ("ffmpeg","ffprobe")}
    runtime.encode_smoke(selected)
    assert "libx264" in calls[0] and calls[-1][-3:]==["-f","null","-"]
    def failure(*a,**k):raise runtime.RuntimeFailure("unknown encoder libx264")
    monkeypatch.setattr(runtime,"capture",failure)
    with pytest.raises(ValueError,match="libx264"):runtime.encode_smoke(selected)


def record():
    identity={"schema":2,"system":"Darwin","machine":"x86_64","python":"3.12.fixture","packages":{"onnxruntime":"fixture"},"tools":{"ffmpeg":"hash"}}
    approval={"template":"fixture","model":"hash"}
    value={"schema":2,"runtime":identity,"runtime_sha256":storage.digest(storage.canonical(identity)),
           "approval_hash":storage.digest(storage.canonical(approval)),"quality_review":"operator-reviewed", "load_seconds":5,"recorded_at":time.time(),
           "variants":{name:{"warm_seconds":[10,11,12],"first_render_seconds":15,"quality_review":"operator-reviewed"} for name in ("off","natural")},
           "warm_seconds":[10,11,12,10,11,12]}
    return value,approval,identity


@pytest.mark.parametrize("change",["python","packages","tools","template","old_schema","missing_variant","nan","infinite","few_samples","unreviewed","half_record"])
def test_calibration_rejects_stale_and_malformed(change):
    value,approval,identity=record()
    assert calibration.validate(value,approval,identity)==value
    identity=copy.deepcopy(identity)
    if change in {"python","packages","tools"}: identity[change]="changed"
    elif change=="template":approval["template"]="changed"
    elif change=="old_schema":value["schema"]=1
    elif change=="missing_variant":del value["variants"]["off"]
    elif change=="nan":value["load_seconds"]=float("nan")
    elif change=="infinite":value["variants"]["natural"]["first_render_seconds"]=float("inf")
    elif change=="few_samples":value["variants"]["off"]["warm_seconds"]=[1,2]
    elif change=="unreviewed":value["variants"]["off"]["quality_review"]=""
    else:value["variants"]["off"]=None
    with pytest.raises(ValueError,match="Calibration"):calibration.validate(value,approval,identity)


def test_benchmark_cleanup_confined_and_preserves_permanent_assets(local):
    import uuid
    directory=local/"benchmarks";directory.mkdir()
    owned=directory/str(uuid.uuid4());owned.mkdir();(owned/"review.mp4").write_bytes(b"fixture")
    keep=directory/"user-notes";keep.mkdir()
    storage.cleanup_benchmarks()
    assert not owned.exists() and keep.exists() and (local/"templates").is_dir()
    link=directory/str(uuid.uuid4());link.symlink_to(local/"templates")
    with pytest.raises(ValueError):storage.cleanup_benchmarks()
    assert (local/"templates").exists()


@pytest.mark.parametrize("change",["python","tools","model","template"])
def test_actual_template_publication_rejects_changed_calibration_before_http(local,monkeypatch,change):
    from swico_video_node import engine,templates
    value,_,identity=record()
    profile={"profile_hash":"fixture-model"}
    monkeypatch.setattr(templates,"audit",lambda:profile)
    monkeypatch.setattr(templates,"evidence",lambda _:None)
    monkeypatch.setattr(engine,"runtime_identity",lambda:identity)
    for identifier in storage.TEMPLATES:
        directory=storage.template_dir(identifier);directory.mkdir()
        (directory/"master.mp4").write_bytes(b"not-native-media-fixture")
        storage.atomic(directory/"tracks.json",{})
        approval={"template_sha256":storage.hash_file(directory/"master.mp4"),"tracks_sha256":storage.hash_file(directory/"tracks.json"),
                  "profile_sha256":profile["profile_hash"],"rights_sha256":storage.digest(storage.canonical({}))}
        calibration_record=copy.deepcopy(value)
        calibration_record["approval_hash"]=storage.digest(storage.canonical(approval))
        storage.atomic(directory/"manifest.json",{"approval":approval,"rights":{},"benchmark":calibration_record,"title":"fixture", "media":{"width":64,"height":64,"duration_seconds":1}})
        assert templates.approved(identifier,calibrated=True)["approval"]==approval
    if change in {"python","tools"}:identity[change]="changed"
    elif change=="model":profile["profile_hash"]="changed"
    else:(storage.template_dir("couple-02")/"master.mp4").write_bytes(b"changed")
    calls=[]
    with pytest.raises(ValueError,match="Calibration|changed"):
        templates.publish(SimpleNamespace(post=lambda *args:calls.append(args)))
    assert not calls


def test_launchd_loaded_is_not_running():
    status=service.launch_status("state = waiting\n last exit code = 78\n",0)
    assert status["loaded"] and not status["running"] and status["last_exit"]==78
    assert service.launch_status("state = running\n pid = 123\n",0)["running"]
    assert not service.launch_status("",113)["loaded"]


def test_launchagent_install_status_stop_contract(local,tmp_path,monkeypatch):
    monkeypatch.setattr(service.platform,"system",lambda:"Darwin")
    monkeypatch.setattr(service.Path,"home",lambda:tmp_path)
    monkeypatch.setattr(service,"tools",lambda:{})
    monkeypatch.setattr(service,"runtime_identity",lambda:{})
    loaded={"value":False}
    def launch(argv,**kw):
        if argv[1]=="bootstrap":loaded["value"]=True
        if argv[1]=="bootout":loaded["value"]=False
        return SimpleNamespace(returncode=0 if loaded["value"] else 113,stdout="state = waiting\nlast exit code = 1\n",stderr="")
    monkeypatch.setattr(service.subprocess,"run",launch)
    monkeypatch.setattr(diagnostics,"api_check",lambda:{"authenticated":False,"status":"credential_mismatch"})
    result=service.service("install")
    body=plistlib.loads(Path(result["plist"]).read_bytes())
    assert body["ProgramArguments"][3]==str(Path(sys.executable).absolute())
    assert body["EnvironmentVariables"]["PATH"].startswith("/opt/local/bin:")
    assert (Path(body["StandardErrorPath"]).stat().st_mode&0o077)==0
    assert service.service("install")["unchanged"]
    status=service.service("status")
    assert status["loaded"] and not status["running"] and not status["local_liveness"]
    assert status["backend"]["status"]=="credential_mismatch"
    assert service.service("stop")["stopped"]
    assert (local/"worker.token").exists()


@pytest.mark.parametrize("key,value",[("WorkingDirectory","/old/repo"),("StandardErrorPath","/old/log"),("KeepAlive",False),("ThrottleInterval",1)])
def test_loaded_service_configuration_change_requires_explicit_stop(local,tmp_path,monkeypatch,key,value):
    monkeypatch.setattr(service.platform,"system",lambda:"Darwin")
    monkeypatch.setattr(service.Path,"home",lambda:tmp_path)
    monkeypatch.setattr(service,"tools",lambda:{})
    monkeypatch.setattr(service,"runtime_identity",lambda:{})
    monkeypatch.setattr(service,"inspect_service",lambda domain:{"loaded":True})
    path=tmp_path/"Library/LaunchAgents"/(service.LABEL+".plist")
    path.parent.mkdir(parents=True)
    body=service.configuration();body[key]=value
    before=plistlib.dumps(body);path.write_bytes(before)
    with pytest.raises(ValueError,match="explicitly service stop"):
        service.service("install")
    assert path.read_bytes()==before


@pytest.mark.parametrize("version,machine",[([3,13,1],"x86_64"),([3,12,1],"arm64")])
def test_setup_wrong_python_or_architecture(version,machine):
    with pytest.raises(ValueError,match="native Intel"):bootstrap.validate_python({"version":version,"machine":machine,"system":"Darwin"})


def test_setup_preserves_incompatible_existing_environment(local,monkeypatch):
    directory=local/"existing venv";(directory/"bin").mkdir(parents=True);(directory/"bin/python").touch()
    def identity(path):return {"version":[3,12,1 if str(path)=="/opt/local/bin/python3.12" else 2],"machine":"x86_64","system":"Darwin","base":"base","prefix":"venv"}
    monkeypatch.setattr(bootstrap,"python_identity",identity)
    with pytest.raises(ValueError,match="Incompatible existing"):bootstrap.environment("/opt/local/bin/python3.12",directory)
    assert (directory/"bin/python").exists()


def test_setup_macports_pipless_venv(local,monkeypatch):
    monkeypatch.setattr(bootstrap,"python_identity",lambda p:{"version":[3,12,1],"machine":"x86_64","system":"Darwin","base":"base","prefix":"venv"})
    calls=[]
    monkeypatch.setattr(bootstrap,"execute",lambda args,**kw:calls.append(args))
    monkeypatch.setattr(bootstrap.subprocess,"run",lambda args,**kw:SimpleNamespace(returncode=0 if str(args[0]).startswith("/opt/local/") else 1))
    bootstrap.environment("/opt/local/bin/python3.12",local/"venv space")
    assert "--without-pip" in calls[0]
    assert calls[1][1:4]==["-m","pip","--python"] and "--only-binary=:all:" in calls[1]
    monkeypatch.setattr(bootstrap.subprocess,"run",lambda *a,**kw:SimpleNamespace(returncode=1))
    with pytest.raises(ValueError,match="py312-pip"):bootstrap.environment("/opt/local/bin/python3.12",local/"new venv")


def test_setup_engine_wrong_dirty_or_interrupted_checkout(local,monkeypatch):
    directory=local/"engine/facefusion";(directory/".git").mkdir(parents=True)
    calls=[]
    monkeypatch.setattr(bootstrap,"execute",lambda args,**kw:calls.append(args))
    monkeypatch.setattr(bootstrap.subprocess,"run",lambda *a,**kw:SimpleNamespace(returncode=1,stdout="HEAD\n"))
    monkeypatch.setattr(bootstrap.subprocess,"check_output",lambda args,**kw:"" if "status" in args else storage.ENGINE_COMMIT)
    assert bootstrap.engine_checkout()==directory
    assert any("fetch" in c for c in calls)
    monkeypatch.setattr(bootstrap.subprocess,"check_output",lambda *a,**kw:" M facefusion/code.py")
    with pytest.raises(ValueError,match="Dirty/wrong"):bootstrap.engine_checkout()


def test_shell_explicit_python_with_spaces_and_no_brew(tmp_path):
    # Shell selection/routing only; no fake inference/platform readiness.
    executable=tmp_path/"native python fixture"
    executable.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n');executable.chmod(0o700)
    result=subprocess.run(["/bin/bash","swico_video_node/scripts/setup_macos.sh","--python",str(executable)],capture_output=True,text=True)
    assert result.returncode==0 and result.stdout=="-m\nswico_video_node.bootstrap\n"
    bad=subprocess.run(["/bin/bash","swico_video_node/scripts/setup_macos.sh","--python","relative"],capture_output=True,text=True)
    assert bad.returncode==1 and "MacPorts" in bad.stderr


def test_unavailable_wheels_fail_without_install_or_source_fallback(local,monkeypatch):
    calls=[]
    def fail(args,**kwargs):
        calls.append(args)
        raise subprocess.CalledProcessError(1,args)
    monkeypatch.setattr(bootstrap,"execute",fail)
    with pytest.raises(ValueError,match="no source-build fallback"):bootstrap.install_dependencies("/fixture/python")
    assert len(calls)==1 and "download" in calls[0] and "--only-binary=:all:" in calls[0]
    assert not (local/"dependency-wheels.json").exists()


def test_actual_render_child_construction_uses_same_minimal_tools_and_supervision(local,monkeypatch):
    import io
    import threading
    import uuid
    from datetime import datetime,timezone,timedelta
    job={"id":str(uuid.uuid4()),"inputs":{"male":storage.digest(b"fixture")},"state":"preflighting","deadline":(datetime.now(timezone.utc)+timedelta(minutes=1)).isoformat()}
    calls=[]
    class Process:
        returncode=0
        stderr=io.BytesIO()
        def poll(self):return 0
    def launch(argv,**kw):
        calls.append((argv,kw))
        storage.atomic(local/"jobs"/job["id"]/"result.json",{"outcome":"valid"})
        return Process()
    class Api:
        boot="fixture"
        def request(self,*a,**kw):return b"fixture"
        def post(self,path,body,*a):calls.append((path,body))
    monkeypatch.setattr(worker,"readiness",lambda:{"ready":True})
    monkeypatch.setattr(worker,"tools",lambda:{})
    monkeypatch.setattr(worker.subprocess,"Popen",launch)
    monkeypatch.setattr(worker,"terminate_tree",lambda p:None)
    monkeypatch.setenv("PROVIDER_API_KEY","secret-not-in-child")
    worker.execute(Api(),job,threading.Event(),99)
    argv,options=calls[0]
    assert argv[:3]==[sys.executable,"-m","swico_video_node"]
    assert options["env"]["PATH"].startswith("/opt/local/bin:")
    assert "PROVIDER_API_KEY" not in options["env"] and "token" not in json.dumps(options["env"])
    assert options["pass_fds"][1]==99 and options["start_new_session"] is True
    assert options["env"]["SWICO_VIDEO_PARENT_FD"]==str(options["pass_fds"][0])
    assert calls[1][0].endswith("/complete") and not (local/"jobs"/job["id"]).exists()
