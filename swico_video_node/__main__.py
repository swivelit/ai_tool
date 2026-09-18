from __future__ import annotations
import argparse
import json
import os
import platform
import plistlib
import subprocess
import sys
from pathlib import Path
from .storage import init, root


def service(action):
    if platform.system()!="Darwin":
        raise ValueError("LaunchAgent requires macOS")
    label="in.swico.video-worker"
    path=Path.home()/"Library/LaunchAgents"/(label+".plist")
    domain=f"gui/{os.getuid()}"
    if action=="install":
        path.parent.mkdir(parents=True,exist_ok=True)
        body={"Label":label,"ProgramArguments":["/usr/bin/caffeinate","-i","-s",str(Path(sys.executable).absolute()),"-m","swico_video_node","run"],
              "WorkingDirectory":str(Path(__file__).resolve().parents[1]),"RunAtLoad":True,"KeepAlive":True,"ThrottleInterval":30,
              "EnvironmentVariables":{"PATH":"/usr/local/bin:/usr/bin:/bin","SWICO_VIDEO_DATA_DIR":str(root())},
              "ProcessType":"Background","ExitTimeOut":10}
        with path.open("wb") as stream:
            plistlib.dump(body,stream)
        path.chmod(0o600)
        subprocess.run(["launchctl","bootstrap",domain,str(path)],check=True)
        return {"plist":str(path),"log":str(root()/"logs/worker.log")}
    if action=="status":
        result=subprocess.run(["launchctl","print",domain+"/"+label],capture_output=True,text=True)
        return {"running":result.returncode==0,"plist":str(path),"log":str(root()/"logs/worker.log")}
    subprocess.run(["launchctl","bootout",domain+"/"+label],check=False,capture_output=True)
    if action=="uninstall":
        path.unlink(missing_ok=True)
    return {"stopped":True,"credentials_preserved":True}


def main():
    parser=argparse.ArgumentParser(prog="python -m swico_video_node")
    commands=parser.add_subparsers(dest="command",required=True)
    p=commands.add_parser("init");p.add_argument("--worker-id",required=True);p.add_argument("--api-base",required=True)
    p=commands.add_parser("models");sub=p.add_subparsers(dest="operation",required=True)
    sub.add_parser("audit");p=sub.add_parser("install");p.add_argument("--profile",choices=["quality-cpu"],required=True)
    p=commands.add_parser("templates");sub=p.add_subparsers(dest="operation",required=True)
    for action in ("import","prepare","review"):
        p=sub.add_parser(action);p.add_argument("--id",choices=["couple-01","couple-02"],required=True)
        if action=="import":
            p.add_argument("--file",required=True);p.add_argument("--title",required=True)
    p=sub.add_parser("publish");p.add_argument("--all",action="store_true",required=True)
    p=commands.add_parser("benchmark");p.add_argument("--all-templates",action="store_true",required=True);p.add_argument("--interactive-sources",action="store_true",required=True);p.add_argument("--runs",type=int,default=3,choices=range(3,31))
    p=commands.add_parser("doctor");p.add_argument("--check-api",action="store_true")
    commands.add_parser("run")
    commands.add_parser("rotate-token", help="Stop/drain first; prints only the new digest for Render")
    p=commands.add_parser("service");p.add_argument("operation",choices=["install","status","stop","uninstall"])
    p=commands.add_parser("_process",help=argparse.SUPPRESS);p.add_argument("directory")
    args=parser.parse_args()
    try:
        result=None
        if args.command=="init":
            init(args.worker_id,args.api_base)
            return 0
        if args.command=="rotate-token":
            from .storage import rotate_token
            rotate_token()
            return 0
        if args.command=="models":
            from .models import audit,install
            result=audit() if args.operation=="audit" else install()
        elif args.command=="templates":
            from . import templates
            if args.operation=="import": result=templates.import_template(args.id,args.file,args.title)
            elif args.operation=="prepare": result=templates.prepare(args.id)
            elif args.operation=="review": result=templates.review(args.id)
            else:
                from .worker import Api
                result=templates.publish(Api())
        elif args.command=="benchmark":
            from .templates import benchmark
            result=benchmark(args.runs)
        elif args.command=="doctor":
            from .worker import Api,readiness
            result={"platform":platform.platform(),"architecture":platform.machine(),"python":platform.python_version(),"ready":False,"native_inference_verified":False}
            try:
                result.update(readiness())
            except (ValueError,FileNotFoundError,ImportError) as exc:
                result["blocker"]=str(exc)[:300]
                result["api_check"]="not_run_prerequisites_missing"
                print(json.dumps(result,indent=2))
                return 1
            if args.check_api:
                result["api"]=Api().request("GET","/health")
        elif args.command=="run":
            from .worker import run
            run()
        elif args.command=="_process":
            from .worker import child_process
            child_process(Path(args.directory))
        elif args.command=="service": result=service(args.operation)
        if result is not None: print(json.dumps(result,indent=2))
        return 0
    except (ValueError,FileNotFoundError,ImportError) as exc:
        print(json.dumps({"ready":False,"error":str(exc)[:300]}),file=sys.stderr)
        return 1


if __name__=="__main__":
    raise SystemExit(main())
