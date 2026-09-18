"""Real ephemeral Valkey/Redis, no network port, shared-service flush or fallback."""
import os
import shutil
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import pytest
import redis
from app.video.cache import VideoCache, PREFIX


@pytest.fixture
def binary_cache():
    executable = os.getenv("SWICO_TEST_VALKEY_SERVER") or shutil.which("valkey-server") or shutil.which("redis-server")
    if not executable:
        pytest.skip("Explicit disposable Valkey/Redis executable required; not cache acceptance")
    with tempfile.TemporaryDirectory(prefix="svv-", dir="/tmp") as temp:
        socket = str(Path(temp) / "v.sock")
        process = subprocess.Popen([executable, "--port", "0", "--unixsocket", socket, "--unixsocketperm", "700",
                                    "--save", "", "--appendonly", "no", "--maxmemory", "256mb", "--maxmemory-policy", "noeviction", "--dir", temp],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        client = redis.Redis(unix_socket_path=socket, socket_timeout=2)
        try:
            for _ in range(100):
                try:
                    if client.ping(): break
                except redis.ConnectionError:
                    if process.poll() is not None: pytest.fail("Disposable cache failed to start")
                    time.sleep(.02)
            else: pytest.fail("Disposable cache startup timed out")
            yield VideoCache(client)
        finally:
            client.close()
            process.terminate()
            process.wait(timeout=10)


def test_real_cache_concurrent_budget_reserves_six_not_seven(binary_cache):
    def reserve(index):
        try: binary_cache.reserve(str(index), int(time.time())+600); return True
        except RuntimeError: return False
    with ThreadPoolExecutor(max_workers=7) as pool:
        result = list(pool.map(reserve, range(7)))
    assert result.count(True) == 6


def test_real_binary_retry_pin_expiry_and_namespace(binary_cache):
    store = binary_cache
    deadline = int(time.time())+600
    store.client.set("ordinary-chat-fixture", b"keep", ex=300)
    store.reserve("one", deadline)
    payload = bytes(range(256))*128
    store.put("one", "male", payload, deadline)
    store.put("one", "male", payload, deadline+500)
    assert store.get("one", "male") == payload
    assert store.client.ttl(PREFIX+"one:male") <= 600
    with pytest.raises(ValueError): store.put("one", "male", b"changed", deadline)
    with pytest.raises(RuntimeError): store.pin("one", ["male", "female"], deadline+3000)
    assert store.client.ttl(PREFIX+"one:male") <= 600  # all-or-nothing promotion
    store.pin("one", ["male"], deadline+3000)
    assert store.client.ttl(PREFIX+"one:male") > 3000
    store.put("one", "output", payload, deadline)
    store.expire_output("one", deadline+50)
    assert store.client.zscore(PREFIX+"reservations", "one") == deadline+50
    store.expire_output("one", int(time.time())-1)
    assert not store.has_output("one")
    with pytest.raises(RuntimeError): store.expire_output("one", deadline)
    store.delete("one")
    assert store.client.get("ordinary-chat-fixture") == b"keep"
    assert store.client.ttl("ordinary-chat-fixture") <= 300


def test_real_cache_bounds_and_missing_reservation(binary_cache):
    deadline = int(time.time())+600
    with pytest.raises(ValueError): binary_cache.put("missing", "male", b"x", deadline)
    binary_cache.reserve("one", deadline)
    with pytest.raises(ValueError): binary_cache.put("one", "male", b"x"*(2*1024**2+1), deadline)
    with pytest.raises(ValueError): binary_cache.put("one", "output", b"x"*(16*1024**2+1), deadline)
    with pytest.raises(ValueError): binary_cache.put("one", "../ordinary", b"x", deadline)
