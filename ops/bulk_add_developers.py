#!/usr/bin/env python3
"""
Bulk add: añade los miembros del grupo origen a platformdevelopers,
excluyendo a los que ya estén en platformadmins, platformmanagers o platformstaff.

Uso:
    python ops/bulk_add_developers.py --dry-run   # solo lista, no añade
    python ops/bulk_add_developers.py             # ejecuta la operación

Requiere sesión activa de `az login` con permisos sobre los grupos.
"""
import json
import subprocess
import sys
import urllib.request
import urllib.error

TENANT_ID = "19e73cc9-78d1-4540-862c-5a89572ef80e"

SOURCE_GROUP = "a2a6fe1b-645c-468c-9714-a02aaa706287"  # Grupo origen
TARGET_GROUP = "a79abcc0-dae8-4ba3-b8e9-7da79db95a4f"  # platformdevelopers
EXCLUDE_GROUPS = [
    ("platformadmins",   "21d068e7-f5b4-4594-b8a5-2812aab20984"),
    ("platformmanagers", "a273419d-c768-4667-9624-b7822684ed27"),
    ("platformstaff",    "ae7b9e18-f1a6-480f-8c96-842bf9da4c4f"),
]

GRAPH = "https://graph.microsoft.com/v1.0"


def get_token() -> str:
    out = subprocess.run(
        [
            "az", "account", "get-access-token",
            "--resource", "https://graph.microsoft.com",
            "--tenant", TENANT_ID,
            "--query", "accessToken",
            "-o", "tsv",
        ],
        check=True, capture_output=True, text=True,
    )
    return out.stdout.strip()


def graph_get(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def graph_post(url: str, token: str, body: dict) -> int:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        # 400 "already exist" = ya está, lo tratamos como ok
        if e.code == 400 and "already exist" in text.lower():
            return 204
        print(f"   ERROR {e.code}: {text[:200]}", file=sys.stderr)
        return e.code


def list_group_members(group_id: str, token: str) -> list:
    members = []
    url = f"{GRAPH}/groups/{group_id}/members?$select=id,displayName,userPrincipalName,mail&$top=999"
    while url:
        page = graph_get(url, token)
        members.extend(page.get("value", []))
        url = page.get("@odata.nextLink")
    return members


def main():
    token = get_token()

    print(f"==> Miembros del grupo origen {SOURCE_GROUP}...")
    source_members = list_group_members(SOURCE_GROUP, token)
    print(f"    {len(source_members)} miembros")

    excluded_ids = set()
    for name, gid in EXCLUDE_GROUPS:
        m = list_group_members(gid, token)
        ids = {x["id"] for x in m if x.get("id")}
        print(f"    Exclusión {name}: {len(ids)} miembros")
        excluded_ids |= ids

    print(f"==> Miembros actuales del destino {TARGET_GROUP}...")
    target_members = list_group_members(TARGET_GROUP, token)
    target_ids = {x["id"] for x in target_members if x.get("id")}
    print(f"    {len(target_ids)} miembros")

    to_add = []
    skipped_excluded = 0
    skipped_already_in = 0
    skipped_non_user = 0
    for m in source_members:
        if m.get("@odata.type") != "#microsoft.graph.user":
            skipped_non_user += 1
            continue
        uid = m.get("id")
        if not uid:
            continue
        if uid in excluded_ids:
            skipped_excluded += 1
            continue
        if uid in target_ids:
            skipped_already_in += 1
            continue
        to_add.append(m)

    print()
    print("==> Resumen:")
    print(f"    Total origen:        {len(source_members)}")
    print(f"    No usuarios:         {skipped_non_user}")
    print(f"    Excluidos por grupo: {skipped_excluded}")
    print(f"    Ya en destino:       {skipped_already_in}")
    print(f"    A añadir:            {len(to_add)}")
    print()

    if not to_add:
        print("Nada que añadir.")
        return

    print("==> Usuarios que se añadirán:")
    for m in to_add:
        print(f"    - {m.get('displayName')} <{m.get('userPrincipalName')}>")
    print()

    if "--dry-run" in sys.argv:
        print("(dry-run) No se añade nada.")
        return

    print("==> Añadiendo a platformdevelopers...")
    ok, fail = 0, 0
    url = f"{GRAPH}/groups/{TARGET_GROUP}/members/$ref"
    for m in to_add:
        body = {"@odata.id": f"{GRAPH}/directoryObjects/{m['id']}"}
        status = graph_post(url, token, body)
        if status in (200, 201, 204):
            ok += 1
            print(f"    [OK] {m.get('displayName')}")
        else:
            fail += 1
            print(f"    [KO {status}] {m.get('displayName')}")

    print()
    print(f"==> Hecho: {ok} añadidos, {fail} fallidos")


if __name__ == "__main__":
    main()
