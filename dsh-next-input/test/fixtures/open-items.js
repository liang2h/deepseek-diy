// Desensitized regression based on the user's visible unfinished-evidence example.
export const OPEN_ITEMS = `## 仍然不能下定论的部分
- 生产白名单有效值、实际部署版本和缓存实际 TTL 尚未取得。
- 入口 Trace 在已知 Span 库中未命中，尚不能提供逐跳耗时。
后续生产查询被审批策略拦截，已停止尝试。
新增入口已保存为待确认候选知识，未将未验证项升级为正式事实。`;
