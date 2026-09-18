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
    sub.add_parser("audit")
    p=sub.add_parser("install");p.add_argument("--profile",choices=["quality-cpu"],required=True)
    p=sub.add_parser("evidence");evidence_sub=p.add_subparsers(dest="evidence_operation",required=True)
    evidence_sub.add_parser("status")
    p=evidence_sub.add_parser("add");p.add_argument("--asset",required=True);p.add_argument("--reviewer",required=True);p.add_argument("--reviewed-at",required=True)
    p.add_argument("--licence-file",required=True);p.add_argument("--permission-file");p.add_argument("--permission-basis",choices=["applicable_licence"])
    p=sub.add_parser("provenance");provenance_sub=p.add_subparsers(dest="provenance_operation",required=True)
    p=provenance_sub.add_parser("status");p.add_argument("--fetch",action="store_true",help="Explicitly fetch only bounded fixed .hash sidecars; never model weights")
    p=provenance_sub.add_parser("record");p.add_argument("--asset",required=True);p.add_argument("--confirm-technical-hash",action="store_true")
    p=commands.add_parser("templates");sub=p.add_subparsers(dest="operation",required=True)
    for action in ("inspect", "normalize"):
        p=sub.add_parser(action);p.add_argument("--file",required=True)
        if action=="normalize": p.add_argument("--output",required=True)
    p=sub.add_parser("rights");rights_sub=p.add_subparsers(dest="rights_operation",required=True)
    p=rights_sub.add_parser("status");p.add_argument("--id",choices=["couple-01","couple-02"],required=True)
    p=rights_sub.add_parser("add");p.add_argument("--id",choices=["couple-01","couple-02"],required=True);p.add_argument("--reviewer",required=True);p.add_argument("--reviewed-at",required=True)
    p.add_argument("--licence-file",required=True);p.add_argument("--permission-file",required=True)
    p.add_argument("--confirm-video-modification",action="store_true");p.add_argument("--confirm-video-distribution",action="store_true");p.add_argument("--confirm-audio-rights",action="store_true")
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
            from .models import audit_report, install
            if args.operation=="audit": result=audit_report()
            elif args.operation=="evidence":
                from .models import add_evidence, evidence_status
                if args.evidence_operation=="status": result=evidence_status()
                else:
                    from .storage import exclusive
                    with exclusive():
                        result=add_evidence(args.asset,args.reviewer,args.reviewed_at,args.licence_file,args.permission_file,args.permission_basis)
            elif args.operation=="provenance":
                from .models import provenance_status, record_provenance
                if args.provenance_operation=="status": result=provenance_status(fetch=args.fetch)
                else:
                    from .storage import exclusive
                    with exclusive(): result=record_provenance(args.asset,confirm_technical_hash=args.confirm_technical_hash)
            else:
                from .storage import exclusive
                with exclusive(): result=install()
        elif args.command=="tools":
            from .runtime import configure_tools,tools
            result=tools() if args.operation=="status" else configure_tools(args.ffmpeg,args.ffprobe)
        elif args.command=="templates":
            from . import templates
            if args.operation=="inspect":
                from .media import inspect_media
                result=inspect_media(args.file)  # Read-only: not even a worker lock write.
            elif args.operation=="normalize": result=templates.normalize(args.file,args.output)
            elif args.operation=="rights":
                if args.rights_operation=="status": result=templates.rights_status(args.id)
                else:
                    from .storage import exclusive
                    with exclusive():
                        result=templates.add_rights(args.id,args.reviewer,args.reviewed_at,args.licence_file,args.permission_file,
                                                    confirm_video_modification=args.confirm_video_modification,
                                                    confirm_video_distribution=args.confirm_video_distribution,
                                                    confirm_audio_rights=args.confirm_audio_rights)
            elif args.operation=="publish":
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
        return 1 if isinstance(result,dict) and (result.get("ready") is False or result.get("accepted") is False) else 0
    except Exception as exc:
        from .runtime import safe_error
        if args.command=="templates":
            from .template_errors import TemplateError
            from .template_errors import ACTIONS
            error=exc if isinstance(exc,TemplateError) else TemplateError("template_operation_failed")
            code=getattr(exc,"code",error.code)
            print(json.dumps({"ready":False,"error":safe_error(exc,"templates"),"action":ACTIONS.get(code,error.action)}),file=sys.stderr)
            return 1
        from .template_errors import ACTIONS
        print(json.dumps({"ready":False,"error":safe_error(exc,args.command),
                          "action":ACTIONS.get(getattr(exc,"code",None),"Use doctor --check-api and models audit; inspect private diagnostic logs")}),file=sys.stderr)
        return 1


if __name__=="__main__":
    raise SystemExit(main())
