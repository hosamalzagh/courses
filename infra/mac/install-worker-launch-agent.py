#!/usr/bin/env python3
"""Keep the local center provisioning queue running after login."""

from pathlib import Path
import os
import plistlib
import subprocess
import time

project = Path(__file__).resolve().parents[2]
api = project / "apps/api"
php = Path.home() / "Library/Application Support/Herd/bin/php85"
if not php.is_file():
    raise SystemExit("Herd PHP 8.5 is required")

label = "com.courses.platform-worker"
uid = os.getuid()
agent = Path.home() / "Library/LaunchAgents" / f"{label}.plist"
logs = Path.home() / "Library/Logs/Courses"
agent.parent.mkdir(parents=True, exist_ok=True)
logs.mkdir(parents=True, exist_ok=True)
payload = {
    "Label": label,
    "ProgramArguments": [str(php), "artisan", "queue:work", "redis", "--queue=platform,default", "--sleep=1", "--tries=3"],
    "WorkingDirectory": str(api),
    "EnvironmentVariables": {"APP_ENV": "local", "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"},
    "RunAtLoad": True,
    "KeepAlive": True,
    "StandardOutPath": str(logs / "worker.out.log"),
    "StandardErrorPath": str(logs / "worker.err.log"),
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
print(f"Platform queue launch agent installed: {agent}")

scheduler_label = "com.courses.scheduler"
scheduler_agent = Path.home() / "Library/LaunchAgents" / f"{scheduler_label}.plist"
scheduler_agent.write_bytes(plistlib.dumps({
    "Label": scheduler_label,
    "ProgramArguments": [str(php), "artisan", "schedule:run"],
    "WorkingDirectory": str(api),
    "EnvironmentVariables": {"APP_ENV": "local", "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"},
    "RunAtLoad": True,
    "StartInterval": 60,
    "StandardOutPath": str(logs / "scheduler.out.log"),
    "StandardErrorPath": str(logs / "scheduler.err.log"),
}))
subprocess.run(["launchctl", "bootout", f"gui/{uid}/{scheduler_label}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for attempt in range(5):
    result = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(scheduler_agent)], capture_output=True, text=True)
    if result.returncode == 0:
        break
    if attempt == 4:
        raise SystemExit(result.stderr)
    time.sleep(0.5)
print(f"Scheduler launch agent installed: {scheduler_agent}")
