#!/usr/bin/env node
'use strict';

const host = process.env.INFISICAL_HOST_URL;
const clientId = process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID;
const clientSecret = process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET;
const projectId = process.env.INFISICAL_PROJECT_ID;
const environment = process.env.INFISICAL_ENV || 'dev';
const secretPath = process.env.INFISICAL_SECRET_PATH || '/';

const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

async function main() {
  for (const [name, value] of Object.entries({
    INFISICAL_HOST_URL: host,
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: clientId,
    INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: clientSecret,
    INFISICAL_PROJECT_ID: projectId,
  })) {
    if (!value) throw new Error(`${name} is not set`);
  }

  const login = await fetch(`${host}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({clientId, clientSecret}),
  });
  const auth = await login.json();
  if (!login.ok || !auth.accessToken) throw new Error(`Infisical login failed (HTTP ${login.status})`);

  const url = new URL(`${host}/api/v3/secrets/raw`);
  url.searchParams.set('workspaceId', projectId);
  url.searchParams.set('environment', environment);
  url.searchParams.set('secretPath', secretPath);
  const response = await fetch(url, {headers: {Authorization: `Bearer ${auth.accessToken}`}});
  const data = await response.json();
  if (!response.ok) throw new Error(`Infisical secrets fetch failed (HTTP ${response.status})`);
  for (const secret of data.secrets || []) process.stdout.write(`${secret.secretKey}=${quote(secret.secretValue)}\n`);
  console.error(`[infisical] loaded ${(data.secrets || []).length} secret(s)`);
}

main().catch(error => { console.error(`[infisical] ${error.message}`); process.exit(1); });
