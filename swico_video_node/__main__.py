from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path
from .storage import init
from .service import service


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
    p=commands.add_parser("tools");sub=p.add_subparsers(dest="operation",required=True)
    sub.add_parser("status")
    p=sub.add_parser("configure");p.add_argument("--ffmpeg");p.add_argument("--ffprobe")
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
            from .models import audit_report,install
            if args.operation=="audit": result=audit_report()
            else:
                from .storage import exclusive
                with exclusive(): result=install()
        elif args.command=="tools":
            from .runtime import configure_tools,tools
            result=tools() if args.operation=="status" else configure_tools(args.ffmpeg,args.ffprobe)
        elif args.command=="templates":
            from . import templates
            if args.operation=="publish":
                from .worker import Api
                result=templates.publish(Api())
            else:
                from .storage import exclusive
                with exclusive():
                    if args.operation=="import": result=templates.import_template(args.id,args.file,args.title)
                    elif args.operation=="prepare": result=templates.prepare(args.id)
                    else: result=templates.review(args.id)
        elif args.command=="benchmark":
            from .templates import benchmark
            result=benchmark(args.runs)
        elif args.command=="doctor":
            from .diagnostics import doctor
            result=doctor(args.check_api)
        elif args.command=="run":
            from .worker import run
            run()
        elif args.command=="_process":
            from .worker import child_process
            child_process(Path(args.directory))
        elif args.command=="service": result=service(args.operation)
        if result is not None: print(json.dumps(result,indent=2))
        return 1 if isinstance(result,dict) and result.get("ready") is False else 0
    except Exception as exc:
        from .runtime import safe_error
        print(json.dumps({"ready":False,"error":safe_error(exc,args.command),
                          "action":"Use doctor --check-api and models audit; inspect private diagnostic logs"}),file=sys.stderr)
        return 1


if __name__=="__main__":
    raise SystemExit(main())
