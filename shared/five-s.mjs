export const fiveSHistoryLimit = 50;

export const fiveSActions = {
  complete: { label: '登记5S完成', previous: [null, 'pass'], permission: 'recordFiveS' },
  pass: { label: '检查通过', previous: ['complete', 'correct'], permission: 'inspectFiveS' },
  rework: { label: '要求整改', previous: ['complete', 'correct'], permission: 'inspectFiveS' },
  correct: { label: '提交整改完成', previous: ['rework'], permission: 'recordFiveS' }
};
