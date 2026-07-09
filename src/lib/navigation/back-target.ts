/**
 * session-nav-hardening — Resolución del destino del Boton_Volver.
 *
 * Feature: session-nav-hardening
 *
 * Lógica pura y determinista que decide, a partir de la prop opcional
 * `destination`, hacia dónde debe navegar el `BotonVolver`. Reutiliza la
 * validación anti open-redirect canónica de `internal-path.ts` (`isInternalPath`)
 * como fuente única de verdad, de modo que nunca se produce un destino externo.
 *
 * Sin dependencias de React ni de Node runtime.
 *
 * _Requirements: 5.6, 5.7, 5.8_
 */

import { isInternalPath } from "./internal-path";

/**
 * Destino resuelto para el control de "volver":
 *  - `explicit`: navegar a `path` (ruta interna ya validada, o `"/"` de fallback).
 *  - `history-or-home`: intentar `history.back` y, si no hay historial interno, `"/"`.
 */
export type BackTarget =
  | { kind: "explicit"; path: string }
  | { kind: "history-or-home" };

/**
 * Resolución TOTAL y segura del destino del Boton_Volver:
 *  - `destination === undefined`        → `{ kind: "history-or-home" }`      (R5.7)
 *  - `destination` interno válido       → `{ kind: "explicit", path: destination }` (R5.6)
 *  - `destination` presente pero inválido → `{ kind: "explicit", path: "/" }` (R5.8)
 *
 * Nunca produce un destino externo: cualquier `destination` presente que no sea
 * una ruta interna válida degrada a `"/"`.
 */
export function resolveBackTarget(destination?: string): BackTarget {
  if (destination === undefined) return { kind: "history-or-home" };
  if (isInternalPath(destination)) return { kind: "explicit", path: destination };
  return { kind: "explicit", path: "/" };
}
