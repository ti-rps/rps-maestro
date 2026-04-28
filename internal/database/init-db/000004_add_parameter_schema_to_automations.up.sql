-- Adiciona schema de parâmetros para cada automação.
-- Formato esperado: array de objetos { name, label, type, required, options, placeholder }
ALTER TABLE automations
ADD COLUMN parameter_schema JSONB;
