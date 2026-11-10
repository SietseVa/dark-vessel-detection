"""Command line interface: `dvd dashboard`, `dvd api` and `dvd predict`.

    uv run dvd dashboard              # API + frontend, open http://localhost:5180
    uv run dvd api --reload           # API only, on :8000
    uv run dvd predict --split val    # fill the prediction cache for the dashboard
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path

from . import __version__
from .config import FRONTEND_DIR, Settings


def _apply_path_options(args: argparse.Namespace) -> Settings:
    """Write the path options to env vars (so a reloaded API process sees them too) and load settings."""
    for opt, env in (("data_dir", "DATA_DIR"), ("runs_dir", "RUNS_DIR"), ("weights", "MODEL_PATH")):
        if value := getattr(args, opt, None):
            os.environ[env] = str(Path(value).resolve())
    return Settings.from_env()


def _require_dataset(settings: Settings) -> None:
    if not settings.has_dataset:
        sys.exit(f"Dataset not found at {settings.data_dir}. Put xview3_tiles there or pass --data-dir.")


def _npm() -> list[str]:
    """npm from PATH, or a throwaway Node.js via uvx when Node is not installed."""
    if npm := shutil.which("npm"):
        return [npm]
    if uvx := shutil.which("uvx"):
        return [uvx, "--from", "nodejs-wheel", "npm"]
    sys.exit("npm not found. Install Node.js 20+ (e.g. `brew install node`) or uv.")


def _serve_api(args: argparse.Namespace) -> None:
    import uvicorn

    uvicorn.run(
        "dark_vessel_detection.api:create_app",
        factory=True,
        host=args.host,
        port=args.port,
        reload=args.reload,
        reload_dirs=[str(Path(__file__).parent)] if args.reload else None,
    )


def cmd_api(args: argparse.Namespace) -> None:
    _require_dataset(_apply_path_options(args))
    _serve_api(args)


def cmd_dashboard(args: argparse.Namespace) -> None:
    _require_dataset(_apply_path_options(args))
    npm = _npm()
    if args.install or not (FRONTEND_DIR / "node_modules").exists():
        print("Installing frontend packages (npm install)...")
        subprocess.run([*npm, "install"], cwd=FRONTEND_DIR, check=True)

    # Vite proxies /api to API_PORT (see frontend/vite.config.ts).
    env = {**os.environ, "API_PORT": str(args.port)}
    vite_args = ["--port", str(args.frontend_port)] + (["--open"] if args.open else [])
    # Own process group, so stopping it also stops the node processes npm/uvx started.
    frontend = subprocess.Popen(
        [*npm, "run", "dev", "--", *vite_args], cwd=FRONTEND_DIR, env=env, start_new_session=True
    )
    print(f"Dashboard: http://localhost:{args.frontend_port}  (API on :{args.port})")
    try:
        _serve_api(args)
    finally:
        _stop_group(frontend)


def _stop_group(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)


def cmd_predict(args: argparse.Namespace) -> None:
    settings = _apply_path_options(args)
    _require_dataset(settings)
    weights = settings.weights()
    if weights is None or not weights.exists():
        sys.exit(f"No weights found (looked for {weights or settings.runs_dir / '**/weights/best.pt'}).")

    from .predict import predict_dataset  # pulls in numpy/ultralytics only when needed

    predict_dataset(settings, weights, split=args.split, batch=args.batch)


def _add_path_options(p: argparse.ArgumentParser) -> None:
    p.add_argument("--data-dir", help="dataset folder with meta/, images/, labels/ (env DATA_DIR)")
    p.add_argument("--runs-dir", help="folder searched for **/weights/best.pt (env RUNS_DIR, default runs/)")
    p.add_argument("--weights", help="a specific .pt file instead of the newest under runs/ (env MODEL_PATH)")


def _add_server_options(p: argparse.ArgumentParser) -> None:
    p.add_argument("--host", default="127.0.0.1", help="API host (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=8000, help="API port (default 8000)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="dvd", description="Dark vessel detection tools.")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    p = sub.add_parser("dashboard", help="start the API and the frontend together")
    _add_server_options(p)
    _add_path_options(p)
    p.add_argument("--frontend-port", type=int, default=5180, help="frontend port (default 5180)")
    p.add_argument("--no-reload", dest="reload", action="store_false", help="don't restart the API on code changes")
    p.add_argument("--install", action="store_true", help="run npm install even if node_modules exists")
    p.add_argument("--open", action="store_true", help="open the dashboard in the browser")
    p.set_defaults(func=cmd_dashboard)

    p = sub.add_parser("api", help="start only the API")
    _add_server_options(p)
    _add_path_options(p)
    p.add_argument("--reload", action="store_true", help="restart on code changes")
    p.set_defaults(func=cmd_api)

    p = sub.add_parser("predict", help="run the model on all tiles and cache the detections")
    _add_path_options(p)
    p.add_argument("--split", choices=["all", "train", "val"], default="all")
    p.add_argument("--batch", type=int, default=16)
    p.set_defaults(func=cmd_predict)

    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
