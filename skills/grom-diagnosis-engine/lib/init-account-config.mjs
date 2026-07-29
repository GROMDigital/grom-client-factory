/**
 * The internal-audit block every new account starts with.
 *
 * Deliberately omits `runtimeWorkflowIds`: absence means every workflow, while `[]` means none.
 */
export function initialInternalAuditConfig({
  serverPath,
  tokenFilePath = null,
  companyId,
} = {}) {
  return {
    transport: {
      kind: 'ghl-internal-audit-stdio',
      serverPath,
      tokenFilePath,
    },
    companyId,
    budgets: { maxDefinitions: 60, maxRuntimeWindows: 60, maxLogPages: 30 },
    emailCopy: true,
    conversationTranscripts: true,
  };
}
