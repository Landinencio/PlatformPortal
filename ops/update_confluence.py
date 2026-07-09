#!/usr/bin/env python3
"""Update an existing Confluence page (storage representation) with new HTML."""
import base64
import json
import sys
import urllib.error
import urllib.request

EMAIL = "ruben.landin@iskaypet.com"
TOKEN = open("/tmp/jira_token.txt").read().strip()
BASE = "https://iskaypet.atlassian.net/wiki/api/v2"
PAGE_ID = "994476033"  # Documentación técnica completa
HTML_PATH = "/tmp/portal_doc.html"

AUTH = "Basic " + base64.b64encode(f"{EMAIL}:{TOKEN}".encode()).decode()


def http(method: str, path: str, body=None):
    url = f"{BASE}{path}" if path.startswith("/") else path
    data = None
    headers = {"Authorization": AUTH, "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            txt = resp.read().decode()
            return resp.status, json.loads(txt) if txt else {}
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} on {method} {url}\n{e.read().decode()}", file=sys.stderr)
        raise


def main():
    status, current = http("GET", f"/pages/{PAGE_ID}")
    title = current["title"]
    version_no = current["version"]["number"]
    new_html = open(HTML_PATH).read()
    payload = {
        "id": PAGE_ID,
        "status": "current",
        "title": title,
        "body": {"representation": "storage", "value": new_html},
        "version": {"number": version_no + 1, "message": "Add infra self-service automation (squad + critical) + infra-live-detector"},
    }
    status, data = http("PUT", f"/pages/{PAGE_ID}", payload)
    print(f"Updated page id={PAGE_ID} title='{title}' version {version_no} -> {data['version']['number']}")


if __name__ == "__main__":
    main()
