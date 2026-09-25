#!/usr/bin/env python3
"""Run the built center UI on loopback whenever this Mac user logs in."""

from pathlib import Path
import os
import plistlib
import shutil
import socket
import subprocess
import time

project = Path(__file__).resolve().parents[2]
web = project / "apps/web"
npm = shutil.which("npm")
if not npm:
    raise SystemExit("npm is required")
if not (web / ".next/BUILD_ID").exists():
    raise SystemExit("Run `npm run build` in apps/web first")

label = "com.courses.center-web"
uid = os.getuid()
agent = Path.home() / "Library/LaunchAgents" / f"{label}.plist"
logs = Path.home() / "Library/Logs/Courses"
agent.parent.mkdir(parents=True, exist_ok=True)
logs.mkdir(parents=True, exist_ok=True)
payload = {
    "Label": label,
    "ProgramArguments": [npm, "run", "start", "--", "--hostname", "127.0.0.1", "--port", "3000"],
    "WorkingDirectory": str(web),
    "EnvironmentVariables": {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "NODE_ENV": "production"},
    "RunAtLoad": True,
    "KeepAlive": True,
    "StandardOutPath": str(logs / "web.out.log"),
    "StandardErrorPath": str(logs / "web.err.log"),
}
agent.write_bytes(plistlib.dumps(payload))
subprocess.run(["launchctl", "bootout", f"gui/{uid}/{label}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for attempt in range(5):
    result = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(agent)], capture_output=True, text=True)
    if result.returncode == 0:
        break
    if attempt == 4:
        raise SystemExit(result.stderr)
    time.sleep(0.5)
subprocess.run(["launchctl", "kickstart", "-k", f"gui/{uid}/{label}"], check=True)
for attempt in range(50):
    try:
        with socket.create_connection(("127.0.0.1", 3000), timeout=0.2):
            break
    except OSError:
        time.sleep(0.2)
else:
    raise SystemExit(f"Next.js did not become ready; inspect {logs / 'web.err.log'}")
print(f"Center UI launch agent installed: {agent}")
