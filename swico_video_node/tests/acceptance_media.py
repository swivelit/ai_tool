"""Explicit native codec acceptance, not auto-collected without operator tools.

Run: python -m pytest swico_video_node/tests/acceptance_media.py -q
Requires the existing reviewed native Intel ffmpeg/ffprobe. No weights, faces,
API, rights fixture, network, payment or email. All media is generated in tmp_path.
This intentionally FAILS if native tools are unavailable; it never skips to green.
"""
import json
from fractions import Fraction
import os
from pathlib import Path
import subprocess
import sys

import pytest

from swico_video_node import engine, runtime, storage, templates


@pytest.fixture
def native(tmp_path,monkeypatch):
    node=tmp_path/"node";monkeypatch.setenv("SWICO_VIDEO_DATA_DIR",str(node))
    result=runtime.configure_tools()  # Actual architecture, library/hash + codec checks.
    assert result["encode_decode_smoke"] and result["native_model_inference"]=="not_run"
    return result["tools"],node


def cli(*args):
    result=subprocess.run([sys.executable,"-m","swico_video_node","templates",*map(str,args)],
                          capture_output=True,text=True,timeout=180,env=os.environ.copy())
    assert result.returncode==0,result.stderr
    return json.loads(result.stdout)


def packets(executable,path):
    return json.loads(runtime.capture([executable,"-v","error","-protocol_whitelist","file","-select_streams","a:0",
        "-show_packets","-show_data_hash","sha256","-show_entries","packet=pts_time,duration_time,data_hash",
        "-of","json",str(path)],limit=512*1024))["packets"]


@pytest.mark.parametrize("fps,count,audio,timescale",[("30",301,True,"1000"),("30000/1001",60,True,"30000"),("30",60,False,"1000")])
def test_real_synthetic_cadence_normalize_import_and_audio_identity(native,tmp_path,fps,count,audio,timescale):
    tools,node=native;source=tmp_path/"synthetic source.mp4";output=tmp_path/"normalized.mp4"
    duration=str(float(Fraction(count,1)/Fraction(fps)))
    args=[tools["ffmpeg"]["path"],"-nostdin","-v","error","-n","-f","lavfi","-i",f"testsrc2=size=496x368:rate={fps}:duration={duration}"]
    if audio:args += ["-f","lavfi","-i",f"sine=frequency=440:sample_rate=48000:duration={duration}"]
    args += ["-map","0:v:0"]
    if audio:args += ["-map","1:a:0","-c:a","aac"]
    args += ["-c:v","libx264","-crf","18","-pix_fmt","yuv420p","-threads","2","-bf","0",
             "-video_track_timescale",timescale,"-fps_mode:v","passthrough",str(source)]
    runtime.capture(args,timeout=120)
    original=storage.hash_file(source)
    inspected=cli("inspect","--file",source)
    assert inspected["accepted"] and inspected["canonical_fps"]==str(Fraction(fps))
    assert inspected["frames"]==count
    if timescale=="1000" and count==301:
        assert inspected["nominal_fps"]!=inspected["average_fps"] and inspected["timestamp_quantized"]
    result=cli("normalize","--file",source,"--output",output)
    assert result["normalized"] and storage.hash_file(source)==original
    after=cli("inspect","--file",output)
    assert after["accepted"] and after["canonical_fps"]==inspected["canonical_fps"]
    assert after["frames"]==count and after["nominal_fps"]==after["average_fps"]
    if audio:
        assert packets(tools["ffprobe"]["path"],source)==packets(tools["ffprobe"]["path"],output)
    imported=cli("import","--id","couple-01","--file",output,"--title","Synthetic codec fixture only")
    assert imported["imported"] and not imported["rights_approved"]
    assert engine.probe(node/"templates/couple-01/master.mp4")["frames"]==count
    assert not list(tmp_path.glob(".swico-normalize-*"))


def test_real_vfr_is_rejected_by_inspect_normalize_and_import(native,tmp_path):
    tools,node=native;source=tmp_path/"synthetic variable cadence.mp4"
    runtime.capture([tools["ffmpeg"]["path"],"-nostdin","-v","error","-n","-f","lavfi","-i",
        "testsrc2=size=496x368:rate=30:duration=2","-vf","select='not(eq(mod(n,3),1))'",
        "-c:v","libx264","-threads","2","-pix_fmt","yuv420p","-fps_mode:v","passthrough",str(source)],timeout=60)
    output=tmp_path/"must not exist.mp4"
    for args in (("inspect","--file",source),("normalize","--file",source,"--output",output),
                 ("import","--id","couple-01","--file",source,"--title","Unapproved synthetic fixture")):
        result=subprocess.run([sys.executable,"-m","swico_video_node","templates",*map(str,args)],
                              capture_output=True,text=True,timeout=120,env=os.environ.copy())
        assert result.returncode==1
        report=json.loads(result.stdout or result.stderr)
        assert (report.get("reason") or report["error"]["reason"])=="template_vfr_unsupported"
    assert not output.exists() and not (node/"templates/couple-01").exists()
    assert not list(tmp_path.glob(".swico-normalize-*"))
