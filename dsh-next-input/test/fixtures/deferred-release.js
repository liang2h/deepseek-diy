// Actual final-body shape reported by lead; only the irrelevant commit listing
// is abbreviated. Earlier commentary/round-boundary text is deliberately absent.
export const DEFERRED_RELEASE_ANSWER = `已分 5 批提交并推送至 \`origin/master\`：

\`\`\`text
...五条commit...
\`\`\`

437 项本地测试通过。本地与远端一致，工作区干净；未创建新发布标签。`;

export const DEFERRED_RELEASE_STATE = Object.freeze({
  firstTask: '本次把变更提交并推送，本轮不创建发布标签。',
  recent: Object.freeze([
    Object.freeze({seq: 1, role: 'user', text: '请提交并推送这批变更，本次不创建发布标签。'}),
    Object.freeze({seq: 2, role: 'assistant', text: DEFERRED_RELEASE_ANSWER}),
  ]),
});
