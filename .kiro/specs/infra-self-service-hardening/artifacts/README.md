# Artifacts — infra-self-service-hardening

Contenido diferido: fragmentos de código/infra que se materializan en **otros
repos** de IskayPet fuera de `platformportal`. Se guardan aquí para preservar
la decisión de diseño y facilitar la copia manual al repo destino.

---

## `PortalRdsCatalogReadOnly.tf` (task 1.2)

Policy IAM inline nueva que concede a `portal-inventory-irsa` el permiso
`rds:DescribeDBEngineVersions` que necesita el `Catalogo_Dinamico` (Fase 2 del
plan). Sin ella, `listRdsEngineOptions()` falla con `credentials_unavailable`
(o `AccessDenied` de AWS) y todo el flujo cae al catálogo estático.

### Dónde aplicarla

| Campo | Valor |
|-------|-------|
| Repo | `iskaypetcom/sre-infra/platform-engineering/aws/shared-general` |
| Fichero destino | `iac/services/roles.tf` |
| Recurso vecino | `aws_iam_role_policy` para `PortalExplorerS3Access` (steering §22) sobre el mismo `aws_iam_role.portal_inventory_irsa` |
| Trust policy | **sin cambios** (el SA `portal-sa` en `n8n` y `platformportal` ya está en la trust) |
| Rama | `feat/SRE-<n>` (sustituir `<n>` por el ticket real del sprint) |
| MR title | `[SRE-<n>] feat: add PortalRdsCatalogReadOnly policy` |
| Target branch | `master` (default del repo shared-general) |
| Requirements que satisface | 1.10, 8.1, 8.2, 8.6 |

### Justificación (auditable)

- **Action**: `rds:DescribeDBEngineVersions` — solo lectura, no aparece en la
  lista prohibida del Req 8.2 (`Create|Modify|Delete|Put|Update|Restore`).
- **Resource**: `"*"` — la API AWS `rds:DescribeDBEngineVersions` **no soporta
  ARN-scoping** (AWS IAM Service Authorization Reference). Es el único
  wildcard permitido por el Req 8.2 y va con Sid explícito para dejarlo por
  escrito en el policy document.
- **Sin trust changes**: el rol `portal-inventory-irsa` ya trusta a
  `portal-sa` en `n8n` y `platformportal` (steering §20). Esta policy solo
  suma permisos data-plane.

### Procedimiento operativo

1. En el clone local del repo `shared-general`, checkout de una rama nueva
   `feat/SRE-<n>` desde `master`.
2. Abrir `iac/services/roles.tf` y pegar el bloque completo de
   `PortalRdsCatalogReadOnly.tf` al final del fichero (o justo debajo del
   bloque `aws_iam_role_policy` de `PortalExplorerS3Access` para agrupar
   policies inline del mismo rol — irrelevante funcionalmente).
3. Commit `[SRE-<n>] feat: add PortalRdsCatalogReadOnly policy`.
4. `git push -u origin feat/SRE-<n>`.
5. Crear la MR con `glab` (target `master`; ver `tool-access.md` §glab CLI).
6. Tras el merge, el pipeline de shared-general aplica el Terraform (job de
   deploy) y crea el `aws_iam_role_policy` en la cuenta tooling
   (`444455556666`).
7. Verificación:
   ```bash
   aws --profile eks-tooling iam get-role-policy \
     --role-name portal-inventory-irsa \
     --policy-name PortalRdsCatalogReadOnly
   ```
   El `PolicyDocument` debe contener el Sid `RdsEngineDescribe` con Action
   `rds:DescribeDBEngineVersions` y Resource `*`.

### Rollback

Reversible con un commit que elimine el bloque `aws_iam_role_policy
"portal_rds_catalog_read_only"`; Terraform borra la policy inline. El resto
del rol y sus policies siguen intactos. No hay dependencias runtime desde
`platformportal` sobre esta policy en la Fase 1 — el consumo real llega en
la Fase 2 (task 3.1, `listRdsEngineOptions`).

### Estado

- [x] Snippet listo (este artefacto).
- [ ] MR abierta en `shared-general`.
- [ ] MR mergeada + Terraform aplicado.
- [ ] Verificado con `aws iam get-role-policy`.

Marcar los checkboxes conforme avance el rollout; la task 1.2 del `tasks.md`
del spec se cierra cuando el MR está mergeado y aplicado.
