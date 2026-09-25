#!/usr/bin/env python3
"""Keep courses.test on Laravel and send center pages to Next.js."""

from pathlib import Path
import subprocess
import tempfile

project = Path(__file__).resolve().parents[2]
herd_home = Path.home() / "Library/Application Support/Herd"
site = herd_home / "config/valet/Nginx/courses.test"
backup = herd_home / "backups/courses.test.nginx"
api_public = project / "apps/api/public"
nginx = Path("/Applications/Herd.app/Contents/Resources/nginx-arm64")
nginx_config = herd_home / "config/nginx/nginx.conf"

current = site.read_text()
marker = "# COURSES_CENTER_ROUTING"
if marker in current:
    current = current.split(marker, 1)[0].rstrip() + "\n"

current = current.replace(
    "server_name courses.test www.courses.test *.courses.test;",
    "server_name courses.test;",
)
if "server_name courses.test;" not in current:
    raise SystemExit("Herd courses.test site config not found; run `herd link courses --isolate=8.5` from apps/api first.")

tenant_server = f"""
{marker}
server {{
    listen 127.0.0.1:80;
    server_name *.courses.test;
    root {api_public};
    client_max_body_size 20M;

    location ^~ /api/ {{
        try_files $uri /index.php?$query_string;
    }}

    location ^~ /sanctum/ {{
        try_files $uri /index.php?$query_string;
    }}

    location = /index.php {{
        include fastcgi_params;
        fastcgi_pass $herd_sock_85;
        fastcgi_param SCRIPT_FILENAME {api_public}/index.php;
        fastcgi_param DOCUMENT_ROOT {api_public};
    }}

    location ~ \\.php$ {{
        return 404;
    }}

    location / {{
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }}
}}
"""

backup.parent.mkdir(parents=True, exist_ok=True)
old_backup = site.with_name("courses.test.before-center-routing")
if old_backup.exists():
    old_backup.replace(backup)
if not backup.exists():
    backup.write_text(site.read_text())
site.write_text(current + tenant_server)

with tempfile.TemporaryDirectory(prefix="courses-nginx-check-") as directory:
    temp = Path(directory)
    temp_sites = temp / "sites"
    temp_sites.mkdir()
    resource_config = Path("/Applications/Herd.app/Contents/Resources/config")
    for source_dir, target_name in ((resource_config / "pro/nginx", "pro"), (resource_config / "default-sites", "defaults")):
        target_dir = temp / target_name
        target_dir.mkdir()
        for source in source_dir.glob("*.conf"):
            (target_dir / source.name).write_text(source.read_text().replace(str(herd_home / "Log"), str(temp)))
    for include_name in ("fastcgi_params", "herd.conf"):
        (temp / include_name).write_text((nginx_config.parent / include_name).read_text().replace(str(herd_home / "Log"), str(temp)))
    for source in site.parent.iterdir():
        if source.is_file():
            (temp_sites / source.name).write_text(source.read_text().replace(str(herd_home / "Log"), str(temp)))
    config = nginx_config.read_text().replace(str(site.parent / "*"), str(temp_sites / "*"))
    config = config.replace(str(resource_config / "pro/nginx/*.conf"), str(temp / "pro/*.conf"))
    config = config.replace(str(resource_config / "default-sites/*.conf"), str(temp / "defaults/*.conf"))
    config = config.replace(str(herd_home / "Log"), str(temp))
    temp_config = temp / "nginx.conf"
    temp_config.write_text(config)
    result = subprocess.run([str(nginx), "-t", "-c", str(temp_config)], capture_output=True, text=True)
permission_only = "syntax is ok" in result.stderr and "bind() to 127.0.0.1:80 failed (13: Permission denied)" in result.stderr
if result.returncode and not permission_only:
    site.write_text(current)
    raise SystemExit(result.stderr)

subprocess.run(["herd", "restart"], check=True)
print("Herd routes courses.test to Laravel and *.courses.test to Next.js, with /api and /sanctum on Laravel.")
