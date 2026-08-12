import io
import json
import os
import tempfile
import time
import zipfile
from datetime import datetime, timezone

import gradio as gr
import requests


OWNER = os.getenv("GITHUB_OWNER", "mmmmhub")
REPO = os.getenv("GITHUB_REPO", "snapgen-video-automation")
API = "https://api.github.com"


def github_headers():
    token = os.getenv("GITHUB_TOKEN")
    if not token:
        raise RuntimeError("Set GITHUB_TOKEN before starting the dashboard")
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def generate(prompt, aspect, resolution, duration):
    prompt = (prompt or "").strip()
    if not prompt:
        raise gr.Error("Enter a video prompt first")

    request_id = f"gradio-{int(time.time() * 1000)}"
    dispatch_time = datetime.now(timezone.utc)
    endpoint = f"{API}/repos/{OWNER}/{REPO}/dispatches"
    payload = {
        "event_type": "create_video",
        "client_payload": {
            "prompt": prompt,
            "aspect": aspect,
            "resolution": resolution,
            "duration": duration,
            "request_id": request_id,
        },
    }

    yield "Sending the video request to GitHub Actions...", None
    response = requests.post(endpoint, headers=github_headers(), json=payload, timeout=30)
    if response.status_code != 204:
        raise gr.Error(f"GitHub dispatch failed: HTTP {response.status_code} {response.text[:300]}")

    yield "Request accepted. Waiting for the GitHub Actions run...", None
    run = wait_for_run(dispatch_time, request_id)
    run_id = run["id"]
    yield f"Action started: run {run_id}. Waiting for SnapGen...", None
    run = wait_for_completion(run_id)
    if run["conclusion"] != "success":
        raise gr.Error(f"GitHub Actions failed: {run['conclusion']}")

    result = download_result(run_id)
    video_url = result.get("video_url") or result.get("download_url")
    if not video_url:
        raise gr.Error("The Action completed but returned no video URL")

    yield "Video generated. Downloading the MP4 for display...", None
    video_path = download_video(video_url)
    yield "Complete", video_path


def wait_for_run(dispatch_time, request_id):
    endpoint = f"{API}/repos/{OWNER}/{REPO}/actions/runs"
    deadline = time.time() + 180
    while time.time() < deadline:
        response = requests.get(
            endpoint,
            headers=github_headers(),
            params={"event": "repository_dispatch", "per_page": 20},
            timeout=30,
        )
        response.raise_for_status()
        runs = response.json().get("workflow_runs", [])
        candidates = [
            run
            for run in runs
            if run.get("event") == "repository_dispatch"
            and parse_time(run["created_at"]) >= dispatch_time
        ]
        identified = [
            run
            for run in candidates
            if request_id in {run.get("name"), run.get("display_title")}
        ]
        if identified:
            candidates = identified
        if candidates:
            return sorted(candidates, key=lambda run: run["created_at"], reverse=True)[0]
        time.sleep(5)
    raise RuntimeError("Timed out waiting for GitHub Actions to create a run")


def wait_for_completion(run_id):
    endpoint = f"{API}/repos/{OWNER}/{REPO}/actions/runs/{run_id}"
    deadline = time.time() + 1800
    while time.time() < deadline:
        response = requests.get(endpoint, headers=github_headers(), timeout=30)
        response.raise_for_status()
        run = response.json()
        if run.get("status") == "completed":
            return run
        time.sleep(10)
    raise RuntimeError("Timed out waiting for the GitHub Actions run")


def download_result(run_id):
    endpoint = f"{API}/repos/{OWNER}/{REPO}/actions/runs/{run_id}/artifacts"
    response = requests.get(endpoint, headers=github_headers(), timeout=30)
    response.raise_for_status()
    artifacts = response.json().get("artifacts", [])
    artifact = next((item for item in artifacts if item["name"].startswith("video-result-")), None)
    if not artifact:
        raise RuntimeError("The Action completed without a video-result artifact")

    archive = requests.get(artifact["archive_download_url"], headers=github_headers(), timeout=60)
    archive.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(archive.content)) as bundle:
        result_name = next(name for name in bundle.namelist() if name.endswith("video-result.json"))
        return json.loads(bundle.read(result_name))


def download_video(url):
    response = requests.get(url, timeout=180, stream=True)
    response.raise_for_status()
    handle = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
    with handle:
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            if chunk:
                handle.write(chunk)
    return handle.name


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


with gr.Blocks(title="SnapGen Video Automation") as demo:
    gr.Markdown("# SnapGen Video Automation\nEnter a prompt, choose output settings, and wait for the generated video.")
    prompt = gr.Textbox(
        label="Video prompt",
        value="A cinematic shot of a futuristic city, highly detailed, 8k resolution",
        lines=4,
    )
    with gr.Row():
        aspect = gr.Dropdown(["16:9", "9:16", "1:1"], value="16:9", label="Aspect ratio")
        resolution = gr.Dropdown(["1080p", "720p", "480p"], value="1080p", label="Quality")
        duration = gr.Dropdown(["8s", "6s", "4s"], value="8s", label="Duration")
    generate_button = gr.Button("Generate", variant="primary")
    status = gr.Markdown("Ready")
    video = gr.Video(label="Generated video", autoplay=False)
    generate_button.click(generate, inputs=[prompt, aspect, resolution, duration], outputs=[status, video])


if __name__ == "__main__":
    demo.launch(server_name=os.getenv("GRADIO_SERVER_NAME", "127.0.0.1"), server_port=int(os.getenv("GRADIO_SERVER_PORT", "7860")))
