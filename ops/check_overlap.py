#!/usr/bin/env python3
"""Detecta usuarios duplicados entre platformdevelopers y los grupos de exclusión."""
import json
import subprocess
import urllib.request

TENANT_ID = "19e73cc9-78d1-4540-862c-5a89572ef80e"
GRAPH = "https://graph.microsoft.com/v1.0"

GROUPS = {
    "platformadmins":     "21d068e7-f5b4-4594-b8a5-2812aab20984",
    "platformmanagers":   "a273419d-c768-4667-9624-b7822684ed27",
    "platformstaff":      "ae7b9e18-f1a6-480f-8c96-842bf9da4c4f",
    "platformdevelopers": "a79abcc0-dae8-4ba3-b8e9-7da79db95a4f",
    "platformexternos":   "fe12dcbb-6f2c-4da6-af08-bcfab93c7392",
}


def token():
    r = subprocess.run(
        ["az", "account", "get-access-token",
         "--resource", "https://graph.microsoft.com",
         "--tenant", TENANT_ID,
         "--query", "accessToken", "-o", "tsv"],
        check=True, capture_output=True, text=True,
    )
    return r.stdout.strip()


def members(gid, t):
    out = []
    url = f"{GRAPH}/groups/{gid}/members?$select=id,displayName,userPrincipalName&$top=999"
    while url:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {t}"})
        with urllib.request.urlopen(req) as r:
            page = json.loads(r.read().decode("utf-8"))
        out.extend(page.get("value", []))
        url = page.get("@odata.nextLink")
    return out


def main():
    t = token()
    data = {}
    for name, gid in GROUPS.items():
        m = members(gid, t)
        data[name] = {x["id"]: x for x in m if x.get("id")}
        print(f"{name}: {len(data[name])} miembros")
    print()

    devs = data["platformdevelopers"]
    for excl in ("platformadmins", "platformmanagers", "platformstaff"):
        overlap = set(devs.keys()) & set(data[excl].keys())
        print(f"=== Solapamiento developers ∩ {excl}: {len(overlap)} ===")
        for uid in overlap:
            u = devs[uid]
            print(f"   - {u.get('displayName')} <{u.get('userPrincipalName')}>")
        print()


if __name__ == "__main__":
    main()
