"""Run an installed-app acceptance command against a pinned, loopback-only model."""
import hashlib
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile

MODEL = "Qwen3.5-9B-Q4_K_M"
REVISION = "3885219b6810b007914f3a7950a8d1b469d598a5"
MODEL_URL = f"https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/{REVISION}/{MODEL}.gguf"
MODEL_SHA = "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8"
SERVERS = {
    ("Darwin", "arm64"): ("macos-arm64.tar.gz", "e940a93856765eff3b2d9c663d123bbeafa06f3220ceaafb0f2382f33983ea3f"),
    ("Darwin", "x86_64"): ("macos-x64.tar.gz", "119f9880beb7b4a6a2dcf1f28668bb6a4b714d235c305cf0230cf9359ef6e9ce"),
    ("Linux", "x86_64"): ("ubuntu-x64.tar.gz", "52644621cbcbd34d276786c1250a1c7c7506d300e513cc28e840b405847f0351"),
    ("Windows", "amd64"): ("win-cpu-x64.zip", "8e0bccb6f41a84ed623084af28530912c96c4194e1fbdce829af3bb2348e1edf"),
}


def download(url, target, expected):
    subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error",
                    "--retry", "3", "--output", str(target), url], check=True)
    with target.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != expected:
            raise ValueError(f"SHA-256 mismatch for {target.name}")


def verify(directory, command):
    system = platform.system()
    suffix, checksum = SERVERS[(system, platform.machine().lower())]
    archive = directory / f"llama-b12722-bin-{suffix}"
    download(f"https://github.com/ggml-org/llama.cpp/releases/download/b12722/{archive.name}", archive, checksum)
    if system == "Windows":
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(directory)
    else:
        with tarfile.open(archive) as bundle:
            bundle.extractall(directory, filter="data")
    server, = directory.rglob("llama-server.exe" if system == "Windows" else "llama-server")
    model = directory / f"{MODEL}.gguf"
    download(MODEL_URL, model, MODEL_SHA)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    config = directory / "models.json"
    config.write_text(json.dumps({"providers": {"localqa": {
        "api": "openai-completions", "baseUrl": base + "/v1", "apiKey": "local-only",
        "compat": {"supportsStrictMode": True, "supportsDeveloperRole": False, "supportsStore": False},
        "models": [{"id": MODEL, "reasoning": True, "contextWindow": 49152, "maxTokens": 8192}],
    }}}), encoding="utf-8")
    env = {**os.environ, "PI_OFFLINE": "1", "VIDEO_EDITOR_PLANNER_MODEL": "localqa/" + MODEL,
           "VIDEO_EDITOR_PLANNER_MODELS": str(config)}
    args = [str(server), "--host", "127.0.0.1", "--port", str(port), "--model", str(model),
            "--alias", MODEL, "-c", "49152", "-np", "1", "--jinja", "--temp", "0", "--seed", "42",
            "--reasoning-budget", "1536", "--offline", "--no-agent"]
    with subprocess.Popen(args, cwd=server.parent) as process:
        try:
            for _ in range(180):
                if process.poll() is not None:
                    raise RuntimeError(f"Model server exited with {process.returncode}")
                try:
                    with urllib.request.urlopen(base + "/health", timeout=2) as response:
                        if response.status == 200:
                            break
                except OSError:
                    pass
                time.sleep(1)
            else:
                raise TimeoutError("Local model failed its health check")
            print(f"Testing with {MODEL}, SHA-256 {MODEL_SHA}", flush=True)
            subprocess.run(command, env=env, check=True)
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Pass the installed-app acceptance command and arguments")
    with tempfile.TemporaryDirectory(prefix="ave-model-qa-") as work:
        verify(Path(work), sys.argv[1:])
