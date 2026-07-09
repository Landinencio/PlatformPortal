import { NextResponse } from "next/server";
import { z } from "zod";
import pool from "@/lib/db";

export const dynamic = "force-dynamic";

const mappingSchema = z.object({
  cluster: z.string().trim().min(1).default("dp-prod"),
  namespace: z.string().trim().min(1),
  deployment: z.string().trim().min(1),
  projectId: z.number().int().positive(),
  team: z.string().trim().min(1).nullable().optional(),
  projectName: z.string().trim().min(1).nullable().optional(),
  source: z.enum(["manual", "heuristic", "service-catalog"]).default("manual"),
  confidence: z.number().min(0).max(1).default(1),
  notes: z.string().trim().min(1).nullable().optional(),
});

const mappingBatchSchema = z.object({
  mappings: z.array(mappingSchema).min(1),
});

function resolveBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const cluster = searchParams.get("cluster") || "dp-prod";
    const projectId = searchParams.get("projectId");
    const team = searchParams.get("team");
    const parsedProjectId = projectId ? Number.parseInt(projectId, 10) : undefined;
    if (projectId && (!Number.isFinite(parsedProjectId ?? NaN) || (parsedProjectId ?? 0) <= 0)) {
      return NextResponse.json(
        { error: "Invalid projectId. Use a positive integer." },
        { status: 400 }
      );
    }

    const conditions = ["cluster = $1"];
    const params: unknown[] = [cluster];

    if (typeof parsedProjectId === "number") {
      conditions.push(`project_id = $${params.length + 1}`);
      params.push(parsedProjectId);
    }
    if (team) {
      conditions.push(`team = $${params.length + 1}`);
      params.push(team);
    }

    const result = await pool.query(
      `
        SELECT
          cluster,
          namespace,
          deployment,
          project_id,
          team,
          project_name,
          source,
          confidence,
          notes,
          created_at,
          updated_at
        FROM k8s_workload_mapping
        WHERE ${conditions.join(" AND ")}
        ORDER BY namespace ASC, deployment ASC
      `,
      params
    );

    return NextResponse.json({
      success: true,
      total: result.rowCount || 0,
      mappings: result.rows,
    });
  } catch (error) {
    console.error("K8s mapping GET error:", error);
    return NextResponse.json(
      { error: "Failed to fetch K8s mappings", details: String(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const expectedToken = process.env.K8S_MAPPING_TOKEN;
    if (expectedToken) {
      const token = resolveBearerToken(request);
      if (!token || token !== expectedToken) {
        return NextResponse.json(
          { error: "Unauthorized mapping update request" },
          { status: 401 }
        );
      }
    }

    const body = await request.json();
    const payload = mappingBatchSchema.parse(body);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (const mapping of payload.mappings) {
        await client.query(
          `
            INSERT INTO k8s_workload_mapping (
              cluster, namespace, deployment, project_id, team, project_name,
              source, confidence, notes, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
            ON CONFLICT (cluster, namespace, deployment)
            DO UPDATE SET
              project_id = EXCLUDED.project_id,
              team = EXCLUDED.team,
              project_name = EXCLUDED.project_name,
              source = EXCLUDED.source,
              confidence = EXCLUDED.confidence,
              notes = EXCLUDED.notes,
              updated_at = NOW()
          `,
          [
            normalize(mapping.cluster),
            normalize(mapping.namespace),
            normalize(mapping.deployment),
            mapping.projectId,
            mapping.team || null,
            mapping.projectName || null,
            mapping.source,
            mapping.confidence,
            mapping.notes || null,
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return NextResponse.json({
      success: true,
      updated: payload.mappings.length,
    });
  } catch (error) {
    console.error("K8s mapping POST error:", error);
    const status = error instanceof Error && error.name === "ZodError" ? 400 : 500;
    return NextResponse.json(
      { error: "Failed to upsert K8s mappings", details: String(error) },
      { status }
    );
  }
}
