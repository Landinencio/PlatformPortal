#!/usr/bin/env python3
"""Upload the Platform Portal documentation to Confluence.

Steps:
1. Create a parent page 'Portal de Plataforma' under page id 5734852 (same level as Grafana).
2. Convert the markdown doc to Confluence storage HTML (pandoc-rendered).
3. Create the child page 'Documentación técnica completa' with the rendered content.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

EMAIL = "ruben.landin@iskaypet.com"
TOKEN = open("/tmp/jira_token.txt").read().strip()
BASE = "https://iskaypet.atlassian.net/wiki/api/v2"
SPACE_ID = "5734616"
PARENT_ROOT = "5734852"  # 'Documentación técnica de Cloud y tooling'

AUTH = "Basic " + base64.b64encode(f"{EMAIL}:{TOKEN}".encode()).decode()


def http(method: str, path: str, body=None):
    url = f"{BASE}{path}" if path.startswith("/") else path
    data = None
    headers = {
        "Authorization": AUTH,
        "Accept": "application/json",
    }
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            txt = resp.read().decode()
            return resp.status, json.loads(txt) if txt else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"HTTP {e.code} on {method} {url}\n{body}", file=sys.stderr)
        raise


def create_page(title: str, parent_id: str, html: str) -> dict:
    payload = {
        "spaceId": SPACE_ID,
        "status": "current",
        "title": title,
        "parentId": parent_id,
        "body": {
            "representation": "storage",
            "value": html,
        },
    }
    status, data = http("POST", "/pages", payload)
    print(f"Created page '{title}' status={status} id={data.get('id')}")
    return data


def main():
    html_path = "/tmp/portal_doc.html"
    body_html = open(html_path).read()

    # 1. Create parent folder page.
    parent_html = (
        "<h1>Portal de Plataforma</h1>"
        "<p>Documentación técnica del Platform Portal de IskayPet "
        "(<a href=\"https://portal.today.tooling.dp.iskaypet.com\">portal.today.tooling.dp.iskaypet.com</a>).</p>"
        "<p>Esta página agrupa los documentos relativos al portal interno: arquitectura, "
        "conexiones externas, snapshots, autenticación, FinOps, IA (Iskay), DORA, métricas, "
        "monitorización sintética, despliegue y operativa.</p>"
        "<h2>Contenido</h2>"
        "<ul><li>Documentación técnica completa</li></ul>"
    )
    parent = create_page(
        title="Portal de Plataforma",
        parent_id=PARENT_ROOT,
        html=parent_html,
    )
    parent_id = parent["id"]

    # 2. Create child page with the rendered doc.
    child = create_page(
        title="Documentación técnica completa",
        parent_id=parent_id,
        html=body_html,
    )
    child_id = child["id"]

    print()
    print("DONE")
    print(f"Parent (Portal de Plataforma): https://iskaypet.atlassian.net/wiki/spaces/TS/pages/{parent_id}")
    print(f"Child  (Documentación técnica completa): https://iskaypet.atlassian.net/wiki/spaces/TS/pages/{child_id}")


if __name__ == "__main__":
    main()
