// Native syntax checks only: deliberately no browser/DOM emulation or fake rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import mermaid from 'mermaid';
import {prepareSource} from '../diagram.js';

mermaid.initialize({startOnLoad: false, securityLevel: 'strict', htmlLabels: false});

test('Chinese WeChat login sequence syntax with seven participants and notes', async () => {
  const result = await mermaid.parse(prepareSource(`sequenceDiagram
    autonumber
    participant P as 家长端小程序
    participant W as 微信平台
    participant G as Gateway
    participant A as Athena
    participant U as UserCenter
    participant D as 数据库
    participant R as Redis
    P->>W: 用户同意手机号授权
    W-->>P: 手机号授权 code
    P->>W: Taro.login()
    W-->>P: 微信登录 code
    P->>G: POST /athena/guarder/wx/login
    G->>A: 登录入口转发
    Note over G,A: 登录入口需分别配置网关、业务拦截器白名单
    A->>W: getSessionResult(wxCode)
    W-->>A: openId、unionId、sessionKey
    A->>W: getPhoneNoInfo(phoneNo)
    W-->>A: 真实手机号`));
  assert.equal(result.diagramType, 'sequence');
});

test('native flowchart parser accepts branching topology', async () => {
  // Rich label sanitization needs a real browser; do not substitute a fake DOM here.
  const result = await mermaid.parse('flowchart TD\nA-->B\nB-->C\nB-->D');
  assert.equal(result.diagramType, 'flowchart-v2');
});

test('invalid source is rejected rather than silently represented as a diagram', async () => {
  await assert.rejects(() => mermaid.parse('sequenceDiagram\nA->>'));
});
