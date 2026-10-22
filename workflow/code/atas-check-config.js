// The build supplies config, requireAdapter, and the original channel/sheet.
// Public identifiers only: the adapter bearer belongs in an n8n credential.
if (!/^\-100\d+$/.test(config.channelId) || config.channelId === originalChannel) {
  throw new Error('Configure a different private ATAS channel ID before running.');
}
if (typeof config.sheetDocumentId !== 'string' || !/^[\w-]+$/.test(config.sheetDocumentId) ||
    typeof config.sheetName !== 'string' || !config.sheetName.trim() || config.sheetName === originalSheet) {
  throw new Error('Configure a separate ATAS signals sheet tab before running.');
}
if (typeof config.errorWorkflowId !== 'string' || !config.errorWorkflowId.trim()) {
  throw new Error('Configure the shared n8n error workflow ID before running.');
}
if (requireAdapter && (typeof config.adapterUrl !== 'string' ||
    !/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[\w/-]*)?\/?$/i.test(config.adapterUrl))) {
  throw new Error('Configure the deployed HTTPS ATAS adapter URL before running.');
}
return $input.all().map(item => ({ ...item, json: { ...item.json, adapterUrl: config.adapterUrl.replace(/\/$/, '') } }));
