"""Synthetic ffprobe contracts; not codecs, face inference or rights evidence."""
import copy
from fractions import Fraction
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from swico_video_node import __main__ as command, engine, media, runtime, storage, templates
from swico_video_node.template_errors import TemplateError


def sample(fps=Fraction(30), count=301, tick=Fraction(1,1000)):
    # Floor rounding reproduces 0, .033, .066, .100 without float accumulation.
    frames=[{"pts": int(Fraction(i,1)/fps/tick)} for i in range(count)]
    video={"codec_type":"video", "codec_name":"h264", "width":496, "height":368,
           "r_frame_rate":str(fps), "avg_frame_rate":"150500/5017" if fps==30 else str(fps),
           "time_base":str(tick), "duration":str(float(Fraction(count,1)/fps)), "nb_frames":str(count)}
    return {"streams":[video],"format":{"duration":video["duration"]}}, {"frames":frames}


@pytest.fixture
def fixture(tmp_path,monkeypatch):
    source=tmp_path/"private source with spaces.mp4";source.write_bytes(b"synthetic not actual video")
    node=tmp_path/"private node";monkeypatch.setenv("SWICO_VIDEO_DATA_DIR",str(node))
    metadata,frames=sample();metadata["streams"][0]["duration"]="10.034"
    calls=[]
    monkeypatch.setattr(media,"tool",lambda name:"/reviewed native tools/"+name)
    def capture(argv,**kwargs):
        calls.append((argv,kwargs))
        assert argv[0]=="/reviewed native tools/ffprobe"
        assert argv[argv.index("-protocol_whitelist")+1]=="file"
        return json.dumps(frames if "-select_streams" in argv else metadata)
    monkeypatch.setattr(media,"capture",capture)
    return source,node,metadata,frames,calls


def test_actual_millisecond_case_accepts_nominal_not_average_and_persists(fixture):
    source,node,metadata,frames,calls=fixture
    report=media.inspect_media(source)
    assert report["accepted"] and report["classification"]=="stable_cfr"
    assert report["canonical_fps"]=="30" and report["average_fps"]=="150500/5017"
    assert report["cadence"]["min_interval_seconds"]==.033
    assert report["cadence"]["max_interval_seconds"]==.034
    assert report["cadence"]["tolerance_seconds"]==.001001
    assert len(calls)==2 and not node.exists()
    assert str(source) not in json.dumps(report)
    before=source.read_bytes()
    result=templates.import_template("couple-01",source,"Reviewed later")
    manifest=storage.read(node/"templates/couple-01/manifest.json")
    assert manifest["media"]["fps"]=="30" and manifest["media"]["frames"]==301
    assert manifest["media"]["timing"]["schema"]==1
    assert manifest["template_sha256"]==storage.hash_file(source)
    assert manifest["rights"]=={} and manifest["approval"] is None and manifest["benchmark"] is None
    assert not result["rights_approved"] and not result["template_approved"] and not result["calibrated"]
    assert (node/"templates/couple-01/master.mp4").read_bytes()==before==source.read_bytes()
    assert (node/"templates/couple-01/master.mp4").stat().st_mode & 0o077==0


@pytest.mark.parametrize("fps,tick,count",[(Fraction(30000,1001),Fraction(1,30000),300),
    (Fraction(30000,1001),Fraction(1,1000),300),(Fraction(24),Fraction(1,12288),48),
    (Fraction(1),Fraction(1,1000),2),(Fraction(60),Fraction(1,60000),1800)])
def test_fractional_and_boundary_rates(fixture,fps,tick,count):
    source,node,metadata,frames,calls=fixture
    new,pts=sample(fps,count,tick);metadata.update(new);frames.update(pts)
    result=engine.probe(source)
    assert result["fps"]==str(fps) and result["frames"]==count


@pytest.mark.parametrize("change,reason",[
    ("vfr","template_vfr_unsupported"),("drift","template_vfr_unsupported"),
    ("phase_change","template_vfr_unsupported"),("duplicate","template_timing_invalid"),
    ("reversed","template_timing_invalid"),("nan_pts","template_timing_invalid"),
    ("missing_pts","template_timing_invalid"),("offset","template_timing_invalid"),
    ("odd","template_odd_dimensions"),("small","template_resolution_unsupported"),
    ("large","template_resolution_unsupported"),("short","template_duration_unsupported"),
    ("long","template_duration_unsupported"),("duration_nan","template_duration_unsupported"),
    ("rate_zero","template_fps_unsupported"),("rate_high","template_fps_unsupported"),
    ("rate_low","template_fps_unsupported"),("avg_nan","template_fps_unsupported"),
    ("avg_infinity","template_fps_unsupported"),("missing_rate","template_cfr_required"),
    ("rate_0_0","template_cfr_required"),("zero_tick","template_timing_invalid"),
    ("wrong_count","template_timing_invalid"),("missing_frames","template_frames_unsupported"),
    ("excess_frames","template_frames_unsupported"),("duration_mismatch","template_timing_invalid"),
])
def test_fail_closed_contract(fixture,change,reason):
    source,node,metadata,frames,calls=fixture
    video=metadata["streams"][0];pts=frames["frames"]
    if change=="vfr":
        for i,f in enumerate(pts): f["pts"]=i*33+(8 if i%2 else 0)
    elif change=="drift":
        for i,f in enumerate(pts): f["pts"]=i*33  # Small local error accumulates: reject.
    elif change=="phase_change":
        for i,f in enumerate(pts): f["pts"]+=min(max(i-100,0),5)
    elif change=="duplicate":pts[20]["pts"]=pts[19]["pts"]
    elif change=="reversed":pts[20]["pts"]=pts[19]["pts"]-1
    elif change=="nan_pts":pts[20]["pts"]="NaN"
    elif change=="missing_pts":pts[20]={}
    elif change=="offset":
        for f in pts:f["pts"]+=1000
    elif change=="odd":video["width"]=495
    elif change=="small":video["height"]=62
    elif change=="large":video["width"]=1922
    elif change=="short":video["duration"]=".99"
    elif change=="long":video["duration"]="30.01"
    elif change=="duration_nan":video["duration"]="NaN"
    elif change=="rate_zero":video["r_frame_rate"]="0/1"
    elif change=="rate_high":video["r_frame_rate"]="61/1"
    elif change=="rate_low":video["r_frame_rate"]="1/2"
    elif change=="avg_nan":video["avg_frame_rate"]="NaN"
    elif change=="avg_infinity":video["avg_frame_rate"]="Infinity"
    elif change=="missing_rate":del video["r_frame_rate"]
    elif change=="rate_0_0":video["r_frame_rate"]="0/0"
    elif change=="zero_tick":video["time_base"]="0/1"
    elif change=="wrong_count":video["nb_frames"]="999"
    elif change=="missing_frames":frames["frames"]=[]
    elif change=="excess_frames":frames["frames"]=pts*6
    elif change=="duration_mismatch":video["duration"]="11"
    report=media.inspect_media(source)
    assert not report["accepted"] and report["reason"]==reason,report
    with pytest.raises(TemplateError) as caught: templates.import_template("couple-01",source,"Title")
    assert caught.value.code==reason
    assert not list((node/"templates").iterdir())  # No master/manifest/staging left.


def test_decimal_timestamp_fallback_is_exact(fixture):
    source,node,metadata,frames,calls=fixture
    frames["frames"]=[{"best_effort_timestamp_time":f"{f['pts']/1000:.6f}"} for f in frames["frames"]]
    assert engine.probe(source)["fps"]=="30"


def test_coarse_timebase_cannot_hide_vfr(fixture):
    source,node,metadata,frames,calls=fixture
    metadata["streams"][0]["time_base"]="1/100"
    frames["frames"]=[{"pts":int(Fraction(i,30)*100)} for i in range(301)]
    assert media.inspect_media(source)["reason"]=="template_vfr_unsupported"


def test_cli_import_error_is_actionable_and_redacted(fixture,monkeypatch,capsys):
    source,node,metadata,frames,calls=fixture
    metadata["streams"][0]["width"]=495
    monkeypatch.setattr(sys,"argv",["swico-video","templates","import","--id","couple-01","--file",str(source),"--title","Private title"])
    assert command.main()==1
    value=capsys.readouterr();result=json.loads(value.err)
    assert result["error"]["reason"]=="template_odd_dimensions"
    assert "even-width" in result["action"] and "logs" not in result["action"]
    assert str(source) not in value.err and "Private title" not in value.err
    assert not (node/"templates/couple-01").exists()


def test_cli_inspect_read_only_and_untrusted_error_redaction(fixture,monkeypatch,capsys):
    source,node,metadata,frames,calls=fixture
    monkeypatch.setattr(sys,"argv",["swico-video","templates","inspect","--file",str(source)])
    assert command.main()==0 and json.loads(capsys.readouterr().out)["accepted"]
    assert not node.exists()
    def failure(*a,**k):raise ValueError("/private/photo https://user:secret@host token=secret stderr")
    monkeypatch.setattr(media,"capture",failure)
    assert command.main()==1
    output=capsys.readouterr().out
    assert json.loads(output)["reason"]=="template_probe_failed"
    assert "secret" not in output and "photo" not in output and not node.exists()


def test_failed_import_copy_and_manifest_never_leave_partial_state(fixture,monkeypatch):
    source,node,metadata,frames,calls=fixture
    def fail(*a,**k): raise OSError("private filesystem path")
    monkeypatch.setattr(templates,"atomic",fail)
    with pytest.raises(TemplateError,match="template_import_failed"):
        templates.import_template("couple-01",source,"title")
    assert not list((node/"templates").iterdir())
    monkeypatch.setattr(media,"copy_master",fail)
    with pytest.raises(TemplateError,match="template_import_failed"):
        templates.import_template("couple-01",source,"title")
    assert not list((node/"templates").iterdir())


def test_import_never_adopts_existing_partial_or_approved_directory(fixture):
    source,node,metadata,frames,calls=fixture
    directory=node/"templates/couple-01";directory.mkdir(parents=True)
    note=directory/"keep";note.write_text("operator-owned")
    with pytest.raises(TemplateError,match="template_existing"):
        templates.import_template("couple-01",source,"title")
    assert note.read_text()=="operator-owned" and len(list(directory.iterdir()))==1


@pytest.fixture
def normalizer(fixture,monkeypatch):
    source,node,metadata,frames,probe_calls=fixture
    metadata["streams"].append({"codec_type":"audio","codec_name":"aac","start_time":"0","duration":"10.034"})
    commands=[]
    monkeypatch.setattr(runtime,"tool",lambda name:"/reviewed native tools/"+name)
    def capture(argv,**kwargs):
        commands.append((argv,kwargs))
        assert argv[0]=="/reviewed native tools/ffmpeg"
        assert argv[argv.index("-protocol_whitelist")+1]=="file"
        if argv[-1]!="-":Path(argv[-1]).write_bytes(b"normalized synthetic fixture")
        return ""
    monkeypatch.setattr(runtime,"capture",capture)
    return source,node,metadata,frames,commands


def test_normalize_then_production_probe_no_source_change_or_unbounded_audio(normalizer):
    source,node,metadata,frames,commands=normalizer
    output=source.parent/"normalized master.mp4";before=source.read_bytes()
    result=templates.normalize(source,output)
    assert result["normalized"] and not result["rights_approved"] and result["audio_mode"]=="copy"
    assert source.read_bytes()==before and engine.probe(output)["fps"]=="30"
    argv,kwargs=commands[0]
    assert argv[argv.index("-enc_time_base:v")+1]=="1/30"
    assert "-vf" not in argv and "-r:v" not in argv
    assert argv[argv.index("-fps_mode:v")+1]=="passthrough"
    assert argv[argv.index("-c:a")+1]=="copy" and argv.count("-map")==2 and "0:a:0?" in argv
    assert "-y" not in argv and "-n" in argv and kwargs["timeout"]==600
    assert output.stat().st_mode&0o077==0 and not list(source.parent.glob(".swico-normalize-*"))


@pytest.mark.parametrize("kind",["file","symlink","broken_symlink","source"])
def test_normalize_no_overwrite(normalizer,kind):
    source,node,metadata,frames,commands=normalizer
    output=source.parent/"existing.mp4"
    if kind=="file":output.write_bytes(b"keep")
    elif kind=="source":output=source
    else: output.symlink_to(source if kind=="symlink" else source.parent/"absent")
    with pytest.raises(TemplateError,match="template_output_existing"):templates.normalize(source,output)
    assert not commands and source.read_bytes()==b"synthetic not actual video"


@pytest.mark.parametrize("failure",["encode","probe","decode","publish_race","interrupt"])
def test_failed_normalization_cleans_only_own_work(normalizer,monkeypatch,failure):
    source,node,metadata,frames,commands=normalizer
    output=source.parent/"result.mp4";original_capture=runtime.capture;original_link=os.link
    def capture(argv,**kwargs):
        answer=original_capture(argv,**kwargs)
        if argv[-1]!="-":
            if failure=="encode":raise RuntimeError("private stderr secret")
            if failure=="probe":metadata["streams"][0]["width"]=495
            if failure=="interrupt":raise KeyboardInterrupt()
        elif failure=="decode":raise RuntimeError("private decode error")
        return answer
    def link(src,dst):
        if failure=="publish_race":Path(dst).write_bytes(b"concurrent operator file")
        return original_link(src,dst)
    monkeypatch.setattr(runtime,"capture",capture);monkeypatch.setattr(templates.os,"link",link)
    with pytest.raises((TemplateError,KeyboardInterrupt)):templates.normalize(source,output)
    if failure=="publish_race":assert output.read_bytes()==b"concurrent operator file"
    else:assert not output.exists()
    assert not list(source.parent.glob(".swico-normalize-*"))
    assert source.read_bytes()==b"synthetic not actual video"


@pytest.mark.parametrize("change",["vfr","audio_codec","multi_audio"])
def test_normalizer_will_not_guess_or_drop_audio(normalizer,change):
    source,node,metadata,frames,commands=normalizer
    if change=="vfr":frames["frames"][8]["pts"]+=10
    elif change=="audio_codec":metadata["streams"][1]["codec_name"]="opus"
    else:metadata["streams"].append(copy.deepcopy(metadata["streams"][1]))
    with pytest.raises(TemplateError):templates.normalize(source,source.parent/"result.mp4")
    assert not commands and not (source.parent/"result.mp4").exists()


@pytest.mark.parametrize("operation",["inspect","normalize"])
def test_actual_new_cli_help(operation):
    result=subprocess.run([sys.executable,"-m","swico_video_node","templates",operation,"--help"],capture_output=True,text=True,timeout=10)
    assert result.returncode==0 and "--file" in result.stdout
    if operation=="normalize":assert "--output" in result.stdout


@pytest.mark.parametrize("body",["truncated{",'{"streams":[]}', '{"streams":null}'])
def test_malformed_probe_is_safe_not_cfr(fixture,monkeypatch,body):
    source,node,metadata,frames,calls=fixture
    monkeypatch.setattr(media,"capture",lambda *a,**k:body)
    result=media.inspect_media(source)
    assert not result["accepted"] and result["reason"] in {"template_probe_failed","template_streams_unsupported"}
    assert not node.exists()


def test_inspect_rejects_missing_directory_and_oversize_without_probe(fixture):
    source,node,metadata,frames,calls=fixture
    assert media.inspect_media(source.parent)["reason"]=="template_source_invalid"
    assert media.inspect_media(source.parent/"missing.mp4")["reason"]=="template_source_invalid"
    with source.open("r+b") as file: file.truncate(media.MAX_BYTES+1)
    assert media.inspect_media(source)["reason"]=="template_size_unsupported"
    assert not calls


def test_new_cadence_code_is_bound_to_existing_profile(fixture,monkeypatch):
    from swico_video_node import models
    # Test only the implementation hash branch; this supplies NO real rights.
    manifest=models.skeleton()
    for asset in manifest["assets"]:asset["sha256"]="a"*64
    monkeypatch.setattr(models,"read",lambda _:manifest)
    monkeypatch.setattr(models,"evidence",lambda *a,**k:None)
    original=models.hash_file;changed={"value":False};seen=[]
    def hashed(path):
        seen.append(path.name)
        return "b"*64 if changed["value"] and path.name=="media.py" else original(path)
    monkeypatch.setattr(models,"hash_file",hashed)
    before=models.audit(require_files=False)["profile_hash"]
    changed["value"]=True
    assert models.audit(require_files=False)["profile_hash"]!=before
    assert {"media.py","template_errors.py"}.issubset(seen)


def test_codec_interrupt_kills_before_caller_cleanup(monkeypatch):
    import io
    class InterruptedProcess:
        stdout=io.BytesIO(b"");stderr=io.BytesIO(b"");killed=False
        def wait(self,timeout=None):
            if not self.killed:raise KeyboardInterrupt()
            return -9
        def poll(self):return -9 if self.killed else None
        def kill(self):self.killed=True
    process=InterruptedProcess()
    monkeypatch.setattr(runtime.subprocess,"Popen",lambda *a,**k:process)
    with pytest.raises(KeyboardInterrupt):runtime.capture(["/reviewed/ffmpeg"])
    assert process.killed


@pytest.mark.parametrize("change",["frames","audio_offset","audio_length","silent_output"])
def test_normalizer_rejects_changed_result_contract(normalizer,monkeypatch,change):
    source,node,metadata,frames,commands=normalizer
    production_probe=engine.probe
    def changed_probe(path):
        result=production_probe(path)
        if path.name=="normalized.mp4":
            if change=="frames":result["frames"]-=1
            elif change=="audio_offset":result["audio"]["start_seconds"]+=.05
            elif change=="audio_length":result["audio"]["duration_seconds"]-=.05
            else:result["audio"]=None
        return result
    monkeypatch.setattr(engine,"probe",changed_probe)
    output=source.parent/"output.mp4"
    with pytest.raises(TemplateError,match="template_normalize_failed"):templates.normalize(source,output)
    assert not output.exists() and not list(source.parent.glob(".swico-normalize-*"))
