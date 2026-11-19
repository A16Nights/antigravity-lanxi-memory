# 蓝汐 · 潮汐认知图谱使用纪律

- 回忆跨会话偏好、项目架构决策、长期目标或历史结论时，优先调用 `cg_recall`（可传 `project` 优先匹配当前项目）并用 `cg_read` 读取关键节点全文。
- 形成明确可复用的新约定、决策或排错结论时，用 `cg_write` 存入 `knowledge` 或 `structural`（重要约定设 `importance >= 0.7` 触发硬保护）；随手记录或未声明层级默认落 `episodic`。
- 涉及长期追踪事项时使用 `cg_goal`；遇到值得沉淀的规律或待解决疑点时使用 `cg_reflect`；批量调整/确认重要度可用 `cg_maintain(op: "set_importance")`。
- 绝不假装记忆落盘成功：只有 `cg_write` 返回 `committed: true` 才算写入成功；归档或降级受硬保护节点必须明确征求用户确认并传 `override: true`。
