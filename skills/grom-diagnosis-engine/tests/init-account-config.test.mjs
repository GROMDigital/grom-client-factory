import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialInternalAuditConfig } from '../lib/init-account-config.mjs';

test('a new account requests bounded runtime for every workflow rather than silently requesting none', () => {
  const config = initialInternalAuditConfig({
    serverPath: '/plugin/dist/server.mjs',
    tokenFilePath: '/private/token.json',
    companyId: 'company_1',
  });

  assert.equal(Object.hasOwn(config, 'runtimeWorkflowIds'), false);
  assert.equal(config.budgets.maxRuntimeWindows, 60);
  assert.equal(config.budgets.maxDefinitions, 60);
});
