#!/usr/bin/env python3
"""Busca un usuario por nombre y muestra a qué grupos pertenece."""
import json
import subprocess
import sys
import urllib.parse
import urllib.request

TENANT_ID = "19e73cc9-78d1-4540-862c-5a89572ef80e"
GRAPH = "https://graph.microsoft.com/v1.0"

GROUPS = {
    "platformadmins":     "21d068e7-f5b4-4594-b8a5-2812aab20984",
    "platformmanagers":   "a273419d-c768-4667-9624-b7822684ed27",
    "platformstaff":      "ae7b9e18-f1a6-480f-8c96-842bf9da4c4f",
    "platformdevelopers": "a79abcc0-dae8-4ba3-b8e9-7da79db95a4f",
    "platformexternos":   "fe12dcbb-6f2c-4da6-af08-bcfab93c7392",
    "ORIGEN(a2a6...)":    "a2a6fe1b-645c-468c-9714-a02aaa706287",
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


def graph_get(url, t):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {t}"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))


def search_user(query, t):
    # Search by displayName/UPN/mail
    q = urllib.parse.quote(query)
    url = (
        f"{GRAPH}/users?"
        f"$filter=startswith(displayName,'{q}') or startswith(userPrincipalName,'{q}') or startswith(mail,'{q}')"
        f"&$select=id,displayName,userPrincipalName,mail&$top=25"
    )
    return graph_get(url, t).get("value", [])


def search_user_contains(query, t):
    # Más amplio
    headers = {"Authorization": f"Bearer {t}", "ConsistencyLevel": "eventual"}
    q = urllib.parse.quote(f'"{query}"')
    url = (
        f"{GRAPH}/users?"
        f"$search=\"displayName:{query}\" OR \"userPrincipalName:{query}\""
        f"&$select=id,displayName,userPrincipalName,mail&$top=25&$count=true"
    )
    req = urllib.request.Request(urllib.parse.quote(url, safe=":/?&=,$\""), headers=headers)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8")).get("value", [])


def member_of(uid, t):
    url = f"{GRAPH}/users/{uid}/memberOf?$select=id,displayName&$top=999"
    out = []
    while url:
        page = graph_get(url, t)
        out.extend(page.get("value", []))
        url = page.get("@odata.nextLink")
    return out


def main():
    if len(sys.argv) < 2:
        print("Uso: find_user.py <nombre o email>")
        return
    query = " ".join(sys.argv[1:])
    t = token()

    # Búsqueda directa
    users = []
    try:
        users = search_user_contains(query, t)
    except Exception as e:
        print(f"(search avanzado falló: {e})")
    if not users:
        # fallback startswith por cada palabra
        for part in query.split():
            users.extend(search_user(part, t))

    # dedupe
    seen = set()
    unique = []
    for u in users:
        if u["id"] not in seen:
            seen.add(u["id"])
            unique.append(u)
    users = unique

    if not users:
        print("Ningún usuario encontrado.")
        return

    portal_group_ids = {gid: name for name, gid in GROUPS.items()}

    for u in users:
        print()
        print(f"=== {u.get('displayName')} ===")
        print(f"   id:  {u.get('id')}")
        print(f"   upn: {u.get('userPrincipalName')}")
        print(f"   mail: {u.get('mail')}")
        groups = member_of(u["id"], t)
        portal_groups = [g for g in groups if g.get("id") in portal_group_ids]
        print(f"   En grupos del portal:")
        if not portal_groups:
            print("      (ninguno)")
        for g in portal_groups:
            print(f"      - {portal_group_ids[g['id']]}  ({g.get('displayName')})")
        print(f"   Resto de grupos ({len(groups) - len(portal_groups)}):")
        for g in groups:
            if g.get("id") not in portal_group_ids:
                print(f"      - {g.get('displayName')}")


if __name__ == "__main__":
    main()
