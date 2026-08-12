from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


PROJECT_DIR = Path(__file__).resolve().parent
SCRIPT = PROJECT_DIR / "script.js"
generation_lock = asyncio.Lock()

app = FastAPI(title="SnapGen Playwright API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=5000)
    aspect: Literal["16:9", "9:16", "1:1"] = "16:9"
    resolution: Literal["1080p", "720p", "480p"] = "1080p"
    duration: Literal["4s", "6s", "8s"] = "8s"
    provider: Literal["veo", "grok"] = "veo"


class GenerateResponse(BaseModel):
    job_id: str
    status: str
    video_url: str
    download_url: str | None = None
    job_uuid: str | None = None
    settings: dict


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "snapgen-playwright-api"}


@app.post("/generate", response_model=GenerateResponse)
async def generate(
    payload: GenerateRequest,
    x_api_key: str | None = Header(default=None),
) -> GenerateResponse:
    expected_key = os.getenv("API_KEY")
    if expected_key and x_api_key != expected_key:
        raise HTTPException(status_code=401, detail="Invalid API key")

    if generation_lock.locked():
        raise HTTPException(status_code=409, detail="Another video is already being generated")
    if not shutil.which(os.getenv("NODE_BINARY", "node")):
        raise HTTPException(status_code=503, detail="Node.js is required to run the Playwright worker")
    if not os.getenv("SNAPGEN_EMAIL") or not os.getenv("SNAPGEN_PASSWORD"):
        raise HTTPException(status_code=503, detail="SNAPGEN_EMAIL and SNAPGEN_PASSWORD are required")

    job_id = f"api-{uuid.uuid4().hex[:12]}"
    job_dir = Path(tempfile.mkdtemp(prefix=f"snapgen-{job_id}-"))
    env = os.environ.copy()
    env.update(
        {
            "PROMPT": payload.prompt.strip(),
            "SNAPGEN_PROVIDER": payload.provider,
            "SNAPGEN_ASPECT": payload.aspect,
            "SNAPGEN_RESOLUTION": payload.resolution,
            "SNAPGEN_DURATION": payload.duration,
            "SNAPGEN_OUTPUT_DIR": str(job_dir),
        }
    )
    node_binary = os.getenv("NODE_BINARY", "node")

    try:
        async with generation_lock:
            process = await asyncio.create_subprocess_exec(
                node_binary,
                str(SCRIPT),
                cwd=str(PROJECT_DIR),
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            output, _ = await process.communicate()
        log = output.decode("utf-8", errors="replace")
        result_path = job_dir / "video-result.json"
        if process.returncode != 0 or not result_path.exists():
            detail = log[-2000:] or "The Playwright worker did not return a result"
            raise HTTPException(status_code=502, detail=detail)
        result = json.loads(result_path.read_text(encoding="utf-8"))
        video_url = result.get("video_url") or result.get("download_url")
        if not video_url:
            raise HTTPException(status_code=502, detail="SnapGen returned no video URL")
        return GenerateResponse(
            job_id=job_id,
            status="complete",
            video_url=video_url,
            download_url=result.get("download_url"),
            job_uuid=result.get("job_uuid"),
            settings=result.get("settings", {}),
        )
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "api:app",
        host=os.getenv("API_HOST", "127.0.0.1"),
        port=int(os.getenv("API_PORT", "8000")),
        reload=False,
    )
