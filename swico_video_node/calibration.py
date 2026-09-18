"""No record upgrades: changed runtime requires measured renders and renewed QA."""
import math
import time
from .storage import canonical, digest

SCHEMA = 2


def positive(value, maximum=14400):
    return type(value) in (int,float) and math.isfinite(value) and 0 < value <= maximum


def validate(record, approval, runtime):
    error = ValueError("Calibration missing/stale/malformed; rerun benchmark and review actual output")
    if not isinstance(record,dict) or record.get("schema") != SCHEMA: raise error
    if record.get("approval_hash") != digest(canonical(approval)) or record.get("runtime") != runtime: raise error
    if runtime.get("system") != "Darwin" or runtime.get("machine") != "x86_64" or runtime.get("schema") != SCHEMA: raise error
    if record.get("runtime_sha256") != digest(canonical(runtime)): raise error
    if record.get("quality_review") != "operator-reviewed" or not positive(record.get("recorded_at"),time.time()+60): raise error
    if not positive(record.get("load_seconds"),600): raise error
    variants=record.get("variants",{})
    if not isinstance(variants,dict) or set(variants)!={"off","natural"}: raise error
    values=[]
    for name in ("off","natural"):
        variant=variants[name]
        if not isinstance(variant,dict) or variant.get("quality_review")!="operator-reviewed": raise error
        warm=variant.get("warm_seconds")
        if not isinstance(warm,list) or not 3<=len(warm)<=30 or not all(positive(t) for t in warm): raise error
        if not positive(variant.get("first_render_seconds")): raise error
        values.extend(warm)
    if values != record.get("warm_seconds"): raise error
    return record
