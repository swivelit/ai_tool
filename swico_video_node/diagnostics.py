"""Independent, bounded read-only pairing checks; no customer/provider probes."""
import json
import platform
import socket
import ssl
import urllib.error
from .runtime import safe_error


def api_check():
    from .worker import Api
    try:
        result=Api().request("GET","/health")
        if not isinstance(result,dict) or result.get("authenticated") is not True or any(
            type(result.get(k)) is not bool for k in ("schema_ready","control_initialized","worker_active","templates_current")):
            return {"authenticated":False,"status":"response_contract_error"}
        return {"status":"authenticated", **{k:result[k] for k in ("authenticated","schema_ready","control_initialized","worker_active","templates_current")}}
    except urllib.error.HTTPError as exc:
        return {"authenticated":False,"status":{401:"credential_mismatch",403:"credential_forbidden",404:"api_not_deployed"}.get(exc.code,"http_error"),"http_status":exc.code}
    except (TimeoutError,socket.timeout): status="network_timeout"
    except urllib.error.URLError as exc:
        status="tls_failure" if isinstance(exc.reason,ssl.SSLError) else "dns_failure" if isinstance(exc.reason,socket.gaierror) else "network_timeout" if isinstance(exc.reason,(TimeoutError,socket.timeout)) else "connect_failure"
    except ssl.SSLError: status="tls_failure"
    except json.JSONDecodeError: status="response_contract_error"
    except FileNotFoundError: status="local_pairing_missing_run_init"
    except ValueError: status="local_configuration_or_redirect_refused"
    except OSError: status="local_or_network_io_failure"
    return {"authenticated":False,"status":status}


def doctor(check_api=False):
    from .worker import readiness
    from .engine import runtime_identity
    from .models import audit_report
    from .templates import approved
    from .runtime import tools
    result={"platform":platform.platform(),"architecture":platform.machine(),"python":platform.python_version(),
            "ready":False,"native_inference_verified":False,"checks":{},"blockers":[]}
    checks=result["checks"]
    # Pairing never depends on model files, templates, current flags or calibration.
    checks["api"]=api_check() if check_api else {"status":"not_requested"}
    for name,call in (("runtime",runtime_identity),("tools",tools),("models",audit_report),
                      ("couple-01",lambda:approved("couple-01",calibrated=True)),
                      ("couple-02",lambda:approved("couple-02",calibrated=True))):
        try:
            value=call()
            good=value.get("ready",True)
            checks[name]={"ready":good}
            if name=="models": checks[name]=value
            if not good: result["blockers"].append(name+": operator evidence/files required")
        except Exception as exc:
            checks[name]={"ready":False,**safe_error(exc,name)}
            result["blockers"].append(name+": "+(str(exc)[:200] if isinstance(exc,ValueError) else "missing/invalid local prerequisite"))
    if check_api and not checks["api"].get("authenticated"): result["blockers"].append("API: "+checks["api"]["status"])
    if not result["blockers"]:
        try: result.update(readiness())
        except Exception as exc: result["blockers"].append("readiness: "+type(exc).__name__)
    if check_api and not (checks["api"].get("schema_ready") and checks["api"].get("control_initialized")):
        result["ready"]=False
        result["blockers"].append("Backend schema/control initialization not ready")
    if check_api and not (checks["api"].get("worker_active") and checks["api"].get("templates_current")):
        result["ready"]=False
        result["blockers"].append("Authenticated backend has no current active worker/matching templates; run/publish after local acceptance")
    return result
