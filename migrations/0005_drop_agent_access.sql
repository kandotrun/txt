-- Agent (MCP) access is removed (spec 1.5): the app is used from the Web only.
--
-- Dropping the tables removes every agent's wrapped VaultKey and token hash, so
-- nothing agent-related is left at rest. Tokens first: they reference agent_keys.
DROP TABLE IF EXISTS agent_tokens;
DROP TABLE IF EXISTS agent_keys;
