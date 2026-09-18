"""User LaunchAgent: loaded != running != fresh local liveness != API ready."""
import json
import os
import platform
import plistlib
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from .storage import exclusive, read, root
from .runtime import minimal_environment, tools
from .engine import runtime_identity

LABEL="in.swico.video-worker"


def startup_logs():
    directory=root()/"logs"
    directory.mkdir(parents=True,exist_ok=True,mode=0o700);directory.chmod(0o700)
    for name in ("startup.stdout.log","startup.stderr.log"):
        path=directory/name
        if path.is_symlink(): raise ValueError("Startup log symlink refused")
        if path.exists() and path.stat().st_size>256*1024:
            path.replace(directory/(name+".1"))
        path.touch(mode=0o600,exist_ok=True);path.chmod(0o600)
    return directory


def launch_status(text, returncode):
    pid=re.search(r"^\s*pid = (\d+)\s*$",text,re.M)
    state=re.search(r"^\s*state = ([\w ]+)\s*$",text,re.M)
    last=re.search(r"^\s*last exit code = (-?\d+)\s*$",text,re.M)
    return {"loaded":returncode==0,"running":returncode==0 and bool(pid) and bool(state and state[1].strip()=="running"),
            "pid":int(pid[1]) if pid else None,"last_exit":int(last[1]) if last else None,
            "launchd_state":state[1].strip() if state else "unloaded"}


def inspect_service(domain):
    response=subprocess.run(["/bin/launchctl","print",domain+"/"+LABEL],capture_output=True,text=True,timeout=10)
    return launch_status(response.stdout,response.returncode)


def configuration():
    directory=root()/"logs"
    return {"Label":LABEL,"ProgramArguments":["/usr/bin/caffeinate","-i","-s",str(Path(sys.executable).absolute()),"-m","swico_video_node","run"],
            "WorkingDirectory":str(Path(__file__).resolve().parents[1]),"RunAtLoad":True,"KeepAlive":True,"ThrottleInterval":30,
            "EnvironmentVariables":minimal_environment(),"ProcessType":"Background","ExitTimeOut":10,
            "StandardOutPath":str(directory/"startup.stdout.log"),"StandardErrorPath":str(directory/"startup.stderr.log")}


def service(action):
    if platform.system()!="Darwin": raise ValueError("LaunchAgent requires macOS")
    path=Path.home()/"Library/LaunchAgents"/(LABEL+".plist")
    domain=f"gui/{os.getuid()}"
    status=inspect_service(domain)
    if action=="status":
        from .diagnostics import api_check
        try:
            live=read(root()/"liveness.json")
            fresh=0<=time.time()-live["time"]<45 and status["pid"] in {live["pid"],live.get("parent_pid")}
            if fresh: os.kill(live["pid"],0)
        except (OSError,ValueError,KeyError,TypeError): fresh=False
        return {**status,"local_liveness":fresh,"backend":api_check(),"plist":str(path),"logs":str(root()/"logs")}
    if action=="install":
        runtime_identity()  # The absolute interpreter must be the native locked venv.
        tools()  # Same pinned identity used in rendering-child/template paths.
        if path.is_symlink(): raise ValueError("LaunchAgent plist symlink refused")
        body=configuration()
        if status["loaded"]:
            if path.exists() and plistlib.loads(path.read_bytes())==body:
                return {"installed":True,"unchanged":True,**status}
            raise ValueError("LaunchAgent loaded; explicitly service stop before runtime update")
        with exclusive():
            # Another operator process may have loaded it while we waited.
            if inspect_service(domain)["loaded"]:
                raise ValueError("LaunchAgent loaded; explicitly service stop before runtime update")
            startup_logs()
            path.parent.mkdir(parents=True,exist_ok=True)
            descriptor,temporary=tempfile.mkstemp(prefix=".swico-plist-",dir=path.parent)
            try:
                with os.fdopen(descriptor,"wb") as stream:
                    plistlib.dump(body,stream);stream.flush();os.fsync(stream.fileno())
                os.chmod(temporary,0o600);os.replace(temporary,path)
            finally:
                if os.path.exists(temporary):os.unlink(temporary)
        subprocess.run(["/bin/launchctl","bootstrap",domain,str(path)],check=True,timeout=15,capture_output=True)
        return {"installed":True,"plist":str(path),"health":"run service status; install is not readiness"}
    if status["loaded"]:
        subprocess.run(["/bin/launchctl","bootout",domain+"/"+LABEL],check=True,capture_output=True,timeout=20)
    remaining=inspect_service(domain)
    if remaining["loaded"]: raise ValueError("LaunchAgent still loaded; stop not confirmed")
    with exclusive():
        if action=="uninstall": path.unlink(missing_ok=True)
    return {"stopped":True,"credentials_preserved":True}
