#!/usr/bin/env python3

"""
Genera los 3 flujos de Azure AD con persistencia hacia el portal.

La integración añade una rama no intrusiva:
  fetch principal -> read report json -> build portal payload -> http request

La rama original de Excel/email se mantiene intacta para no romper el flujo actual.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AZURE_FLOWS = ROOT / "AzureFlows"
PORTAL_URL = "http://n8n-webhooks.n8n.svc.cluster.local:3000/api/cybersecurity/intake"


def replace_once(content: str, old: str, new: str, context: str) -> str:
    if old not in content:
      raise ValueError(f"No se encontró el bloque esperado en {context}")
    return content.replace(old, new, 1)


def patch_inactive_fetch_script(script: str) -> str:
    script = replace_once(
        script,
        "&$select=id,userPrincipalName,createdDateTime,department,signInActivity' +\n",
        "&$select=id,displayName,mail,userPrincipalName,createdDateTime,department,companyName,signInActivity' +\n",
        "inactive fetch select",
    )
    script = replace_once(
        script,
        "      rows.push({\n"
        "        userPrincipalName: u.userPrincipalName || '',\n"
        "        lastLogin: lastLoginDisplay,\n"
        "        createdDate: (u.createdDateTime || '').substring(0, 10),\n"
        "        department: u.department || ''\n"
        "      });\n",
        "      rows.push({\n"
        "        id: u.id || '',\n"
        "        displayName: u.displayName || '',\n"
        "        mail: u.mail || '',\n"
        "        userPrincipalName: u.userPrincipalName || '',\n"
        "        lastLogin: lastLoginDisplay,\n"
        "        lastNonInteractive: lastNI ? lastNI.substring(0, 19).replace('T', ' ') : null,\n"
        "        createdDate: (u.createdDateTime || '').substring(0, 10),\n"
        "        department: u.department || '',\n"
        "        company: u.companyName || '',\n"
        "        days: latest ? Math.floor((now - new Date(latest)) / 86400000) : null\n"
        "      });\n",
        "inactive rows push",
    )
    return script


def patch_mfa_fetch_script(script: str) -> str:
    return replace_once(
        script,
        "    return {\n"
        "      displayName: u.displayName || '',\n",
        "    return {\n"
        "      id: u.id || '',\n"
        "      displayName: u.displayName || '',\n",
        "mfa rows map",
    )


def patch_vpn_fetch_script(script: str) -> str:
    script = replace_once(
        script,
        "&$select=id,userPrincipalName,createdDateTime,signInActivity' +\n",
        "&$select=id,displayName,mail,userPrincipalName,createdDateTime,department,signInActivity' +\n",
        "vpn fetch select",
    )
    script = replace_once(
        script,
        "    userMap.set(u.id, {\n"
        "      userPrincipalName: u.userPrincipalName || '',\n"
        "      createdDate: (u.createdDateTime || '').substring(0, 10),\n"
        "      lastLogin: latest ? latest.substring(0, 19).replace('T', ' ') : 'Nunca'\n"
        "    });\n",
        "    userMap.set(u.id, {\n"
        "      id: u.id || '',\n"
        "      displayName: u.displayName || '',\n"
        "      mail: u.mail || '',\n"
        "      userPrincipalName: u.userPrincipalName || '',\n"
        "      department: u.department || '',\n"
        "      createdDate: (u.createdDateTime || '').substring(0, 10),\n"
        "      lastLogin: latest ? latest.substring(0, 19).replace('T', ' ') : 'Nunca',\n"
        "      lastNonInteractive: lastNI ? lastNI.substring(0, 19).replace('T', ' ') : null\n"
        "    });\n",
        "vpn user map",
    )
    script = replace_once(
        script,
        "        members.push({\n"
        "          userPrincipalName: m.userPrincipalName || m.displayName || m.id,\n"
        "          createdDate: 'N/D',\n"
        "          lastLogin: 'N/D'\n"
        "        });\n",
        "        members.push({\n"
        "          id: m.id || '',\n"
        "          displayName: m.displayName || '',\n"
        "          mail: '',\n"
        "          userPrincipalName: m.userPrincipalName || m.displayName || m.id,\n"
        "          department: '',\n"
        "          createdDate: 'N/D',\n"
        "          lastLogin: 'N/D',\n"
        "          lastNonInteractive: null\n"
        "        });\n",
        "vpn fallback member",
    )
    return script


def make_read_report_node(name: str, report_file: str, position: list[int], node_id: str) -> dict:
    return {
        "parameters": {
            "command": f"cat {report_file}",
            "cwd": "/tmp",
        },
        "name": name,
        "type": "n8n-nodes-base.executeCommand",
        "typeVersion": 1,
        "position": position,
        "id": node_id,
        "continueOnFail": True,
    }


def make_payload_node(name: str, code: str, position: list[int], node_id: str) -> dict:
    return {
        "parameters": {
            "jsCode": code,
        },
        "name": name,
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": position,
        "id": node_id,
        "continueOnFail": True,
    }


def make_http_node(name: str, position: list[int], node_id: str) -> dict:
    return {
        "parameters": {
            "method": "POST",
            "url": PORTAL_URL,
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "={{ $json }}",
            "options": {
                "timeout": 30000,
            },
        },
        "name": name,
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": position,
        "id": node_id,
        "continueOnFail": True,
    }


def add_portal_branch(
    flow: dict,
    *,
    fetch_node_name: str,
    report_file: str,
    payload_code: str,
    node_suffix: str,
) -> dict:
    fetch_node = next(node for node in flow["nodes"] if node["name"] == fetch_node_name)
    fetch_x, fetch_y = fetch_node["position"]

    read_name = "Read Report JSON"
    payload_name = "Build Portal Payload"
    http_name = "HTTP Request to Portal"

    flow["nodes"].extend(
        [
            make_read_report_node(read_name, report_file, [fetch_x + 260, fetch_y + 220], f"read-report-json-{node_suffix}"),
            make_payload_node(payload_name, payload_code, [fetch_x + 540, fetch_y + 220], f"build-portal-payload-{node_suffix}"),
            make_http_node(http_name, [fetch_x + 840, fetch_y + 220], f"http-request-portal-{node_suffix}"),
        ]
    )

    connection = flow["connections"].setdefault(fetch_node_name, {"main": [[]]})
    connection["main"][0].append(
        {
            "node": read_name,
            "type": "main",
            "index": 0,
        }
    )
    flow["connections"][read_name] = {
        "main": [[{"node": payload_name, "type": "main", "index": 0}]]
    }
    flow["connections"][payload_name] = {
        "main": [[{"node": http_name, "type": "main", "index": 0}]]
    }

    return flow


INACTIVE_PAYLOAD_CODE = """const fetchOutput = $('Fetch Inactive Users').first().json.stdout || '';
const totalInactive = Number((fetchOutput.match(/TOTAL_INACTIVE: (\\d+)/) || [])[1] || '0');
const neverLogin = Number((fetchOutput.match(/NEVER_LOGIN: (\\d+)/) || [])[1] || '0');
const oldLogin = Number((fetchOutput.match(/OLD_LOGIN: (\\d+)/) || [])[1] || '0');
const rawData = JSON.parse(($('Read Report JSON').first().json.stdout || '[]').trim());

return [{
  json: {
    source: 'azure_ad',
    reportType: 'inactive_users_90d',
    status: 'completed',
    schemaVersion: '1',
    sourceRunId: String($execution.id || ''),
    generatedAt: new Date().toISOString(),
    meta: {
      workflow: 'Azure AD - Usuarios inactivos 90 dias',
      thresholdDays: 90
    },
    summary: {
      totalInactive,
      neverLogin,
      oldLogin
    },
    records: rawData.map((row) => ({
      id: row.id || null,
      displayName: row.displayName || null,
      mail: row.mail || null,
      userPrincipalName: row.userPrincipalName || row.upn,
      department: row.department || null,
      company: row.company || null,
      createdDate: row.createdDate || row.created || null,
      lastLogin: row.lastLogin === 'Nunca' ? null : row.lastLogin,
      lastNonInteractiveLogin: row.lastNonInteractive || null,
      daysInactive: typeof row.days === 'number' ? row.days : null,
      neverLoggedIn: row.lastLogin === 'Nunca'
    }))
  }
}];"""


MFA_PAYLOAD_CODE = """const fetchOutput = $('Fetch & Filter Users').first().json.stdout || '';
const totalUsers = Number((fetchOutput.match(/Result: (\\d+) users/) || [])[1] || '0');
const neverLogin = Number((fetchOutput.match(/(\\d+) never logged/) || [])[1] || '0');
const over90d = Number((fetchOutput.match(/(\\d+) >90 days/) || [])[1] || '0');
const rawData = JSON.parse(($('Read Report JSON').first().json.stdout || '[]').trim());

return [{
  json: {
    source: 'azure_ad',
    reportType: 'users_without_mfa_group',
    status: 'completed',
    schemaVersion: '1',
    sourceRunId: String($execution.id || ''),
    generatedAt: new Date().toISOString(),
    meta: {
      workflow: 'Azure AD - Usuarios sin grupo MFA',
      groupConMfaId: $('Config').first().json['GROUP_CON_MFA_ID'],
      groupSinMfaId: $('Config').first().json['GROUP_SIN_MFA_ID']
    },
    summary: {
      totalUsers,
      neverLogin,
      over90d
    },
    records: rawData.map((row) => ({
      id: row.id || null,
      upn: row.upn || row.userPrincipalName,
      displayName: row.displayName || null,
      mail: row.mail || null,
      department: row.department || null,
      jobTitle: row.jobTitle || null,
      company: row.company || null,
      created: row.created || row.createdDate || null,
      lastLogin: row.lastLogin === 'Nunca' ? null : row.lastLogin,
      lastNonInteractive: row.lastNonInteractive || null,
      days: typeof row.days === 'number' ? row.days : null,
      neverLoggedIn: row.lastLogin === 'Nunca'
    }))
  }
}];"""


VPN_PAYLOAD_CODE = """const fetchOutput = $('Fetch VPN Groups').first().json.stdout || '';
const totalGroups = Number((fetchOutput.match(/TOTAL_GROUPS: (\\d+)/) || [])[1] || '0');
const totalMembers = Number((fetchOutput.match(/TOTAL_MEMBERS: (\\d+)/) || [])[1] || '0');
const rawData = JSON.parse(($('Read Report JSON').first().json.stdout || '[]').trim());

return [{
  json: {
    source: 'azure_ad',
    reportType: 'vpn_groups',
    status: 'completed',
    schemaVersion: '1',
    sourceRunId: String($execution.id || ''),
    generatedAt: new Date().toISOString(),
    meta: {
      workflow: 'Azure AD - Grupos VPN reporte',
      groupPrefix: $('Config').first().json['VPN_GROUP_PREFIX']
    },
    summary: {
      totalGroups,
      totalMembers,
      groupsWithMembers: rawData.filter((group) => Number(group.memberCount || 0) > 0).length
    },
    records: rawData.map((group) => ({
      groupId: group.groupId || null,
      groupName: group.groupName || null,
      description: group.description || null,
      memberCount: Number(group.memberCount || 0),
      members: Array.isArray(group.members) ? group.members.map((member) => ({
        id: member.id || null,
        displayName: member.displayName || null,
        mail: member.mail || null,
        userPrincipalName: member.userPrincipalName,
        department: member.department || null,
        createdDate: member.createdDate || null,
        lastLogin: member.lastLogin === 'Nunca' || member.lastLogin === 'N/D' ? null : member.lastLogin,
        lastNonInteractiveLogin: member.lastNonInteractive || null,
        neverLoggedIn: member.lastLogin === 'Nunca'
      })) : []
    }))
  }
}];"""


def generate_flow(
    *,
    source_file: str,
    output_file: str,
    flow_name: str,
    flow_id: str,
    version_id: str,
    fetch_node_name: str,
    report_file: str,
    payload_code: str,
    patch_fetch_script,
) -> None:
    source_path = AZURE_FLOWS / source_file
    target_path = AZURE_FLOWS / output_file

    flow = json.loads(source_path.read_text())
    flow = copy.deepcopy(flow)
    flow["name"] = flow_name
    flow["id"] = flow_id
    flow["versionId"] = version_id

    fetch_script_node = next(node for node in flow["nodes"] if node["name"] == "Build Fetch Script")
    fetch_script_node["parameters"]["jsCode"] = patch_fetch_script(fetch_script_node["parameters"]["jsCode"])

    flow = add_portal_branch(
        flow,
        fetch_node_name=fetch_node_name,
        report_file=report_file,
        payload_code=payload_code,
        node_suffix=flow_id,
    )

    target_path.write_text(json.dumps(flow, indent=2, ensure_ascii=False) + "\n")


def main() -> None:
    generate_flow(
        source_file="Azure AD - Usuarios inactivos 90 dias.json",
        output_file="Azure AD - Usuarios inactivos 90 dias - CON PORTAL.json",
        flow_name="Azure AD: Usuarios inactivos (+90 días) + Portal",
        flow_id="azure-inactive-users-portal-001",
        version_id="azure-inactive-users-portal-v1",
        fetch_node_name="Fetch Inactive Users",
        report_file="/tmp/azure_inactive_users_report.json",
        payload_code=INACTIVE_PAYLOAD_CODE,
        patch_fetch_script=patch_inactive_fetch_script,
    )
    generate_flow(
        source_file="Azure AD - Usuarios sin grupo MFA.json",
        output_file="Azure AD - Usuarios sin grupo MFA - CON PORTAL.json",
        flow_name="Azure AD: Usuarios sin grupo MFA + Portal",
        flow_id="azure-mfa-check-portal-001",
        version_id="azure-mfa-check-portal-v1",
        fetch_node_name="Fetch & Filter Users",
        report_file="/tmp/azure_mfa_report.json",
        payload_code=MFA_PAYLOAD_CODE,
        patch_fetch_script=patch_mfa_fetch_script,
    )
    generate_flow(
        source_file="Azure AD - Grupos VPN reporte.json",
        output_file="Azure AD - Grupos VPN reporte - CON PORTAL.json",
        flow_name="Azure AD: Reporte Grupos VPN (AZ_VPN) + Portal",
        flow_id="azure-vpn-groups-portal-001",
        version_id="azure-vpn-groups-portal-v1",
        fetch_node_name="Fetch VPN Groups",
        report_file="/tmp/azure_vpn_groups_report.json",
        payload_code=VPN_PAYLOAD_CODE,
        patch_fetch_script=patch_vpn_fetch_script,
    )

    print("Generated 3 n8n flows with portal integration.")


if __name__ == "__main__":
    main()
