-- 2026-07-06 — infra_requests: columna error_message + índice GIN parcial.
--
-- Añade columna JSONB para persistir Error_Persistido (Req 5.6, spec
-- infra-self-service-hardening). Aditiva y compatible ida/vuelta: el código
-- v0.23.0-rc.1 (pre-feature) ignora la columna; el rollback es
-- `DROP COLUMN IF EXISTS error_message` + `DROP INDEX IF EXISTS
-- idx_infra_requests_error_message_code` sin pérdida funcional (sólo se
-- pierde el histórico de Error_Persistido). NO altera ninguna columna,
-- constraint ni índice existente (Req 10.1).

ALTER TABLE infra_requests
  ADD COLUMN IF NOT EXISTS error_message JSONB;

-- Índice GIN parcial para consultas de auditoría por código de error.
-- Ejemplo de query beneficiada:
--   SELECT error_message->>'code' AS code, count(*)
--   FROM infra_requests
--   WHERE error_message IS NOT NULL
--   GROUP BY 1 ORDER BY 2 DESC;
CREATE INDEX IF NOT EXISTS idx_infra_requests_error_message_code
  ON infra_requests ((error_message->>'code'))
  WHERE error_message IS NOT NULL;
