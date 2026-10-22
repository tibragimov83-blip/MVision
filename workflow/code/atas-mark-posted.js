// Static data is persisted only after a successful active workflow execution.
// Telegram has already succeeded; its response replaces the original input.
const sessionDate = $('Format ATAS context').first().json.sessionDate;
$getWorkflowStaticData('global').atasLastPostedSession = sessionDate;
return [{ json: { sessionDate, posted: true }, pairedItem: { item: 0 } }];
