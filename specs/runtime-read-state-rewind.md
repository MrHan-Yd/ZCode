# 回退会话时保留上下文已读记录

## 范围与上游依据

本次只修复官方 `a60ba6a7e5a06742270ca605f5d2cc2766afa7e1`（v3.17.1 同步快照）中已修复的严重运行时缺陷：`read-file-state-hydrator.ts` 回退时整表清空已读状态，丢掉初始化上下文已提供的 `MEMORY.md`，随后 Write 被误拒绝为未读。

只移植 `seededFromContext` 与 `retainContextSeeds` 对应的保证，以及同快照 `inSnapshotOrder` 中跳过 `READ_FILE_UNCHANGED_STUB` 的保证：命中缓存没有重新提供正文，不能覆盖上下文种子或恢复未见内容。不移植官方的范围 Read 恢复、快照排序、FillWorkflowHole 或上下文构建重构；保留本地记忆数据根、编排提示词、完整/范围视图规则和 stale-write 保护。

## 状态所有者与规则

- 唯一所有者仍是当前 `AgentRuntime.readFileState`。上下文初始化负责标记它实际读取并提供给模型的记忆索引记录，工具执行仍按既有方式更新该 Map。
- 新增可选的内存标记 `seededFromContext`；只标记上下文真实读取的记录，不根据路径名推断，不持久化到工具快照中。
- 同一运行时 rewind 时，hydrator 只保留带该标记的记录，清除其余旧分支工具记录，再按本地已有 active-history 规则恢复保留分支的工具快照。
- 工具完整读取或写入覆盖了上下文种子时，不继承该标记；被回退的工具内容不得作为上下文已读内容留下。
- 冷恢复默认不保留内存种子：先清除 Map，再由当前会话的上下文初始化真实读取索引。旧调用不传新参数时行为不变。
- 保留种子不是绕过权限或 freshness 校验。原始 revision、mtime、大小、部分视图标记必须保留；文件在磁盘上变化时仍拒绝 stale write，截断内容仍不得被认作完整视图。
- 不新增持久化 owner、队列、接口写入路径或远程身份格式；workspace identity、owner/lease、编排代次和 CommandInbox admission 不变。

## 事件顺序

```text
上下文真实读取 MEMORY.md
  → runtime.readFileState 写入带种子标记的记录
  → 模型获得上下文
  → rewind owner 选定保留分支
  → hydrator 保留尚未被工具覆盖的种子，清除旧工具记录
  → 从保留分支恢复工具快照
  → 重建上下文前缀
  → 后续 Write 仍经过已有已读/部分视图/revision 校验
```

Desktop continuous 与手机 replayable 都复用同一运行时 owner；本修复不改变传输、事件序号、快照重放或乐观草稿状态。

## 验收场景

1. 上下文提供了完整 `MEMORY.md`，用户回退未读写该文件的轮次，种子仍在且对象中的 revision、mtime、大小均不变；Write 不再误报未读。
2. 回退前的普通工具已读记录即使文件名也是 `MEMORY.md`，未标记种子时也必须清除。
3. 保留分支有带完整结构化 metadata 的 Read/Write/Edit，恢复后该工具记录取代种子，不保留种子标记。
4. 被回退分支的工具内容覆盖了种子，回退后不能保留被丢弃内容；没有保留分支读取时必须重新 Read。
5. 冷恢复不传 `retainContextSeeds` 时清除全部旧内存记录；历史完整/范围 Read 恢复行为保持本地原规则。
6. seed 的 partial/freshness 状态不得被升级或重置；变化文件仍触发既有 stale guard。
7. 本地 CreateWorkflow/AmendWorkflow 内联草稿的已读快照恢复和编排上下文构建保持不变。
8. 上下文种子之后 Read 命中 `file_unchanged`，第一次回退保留该缓存调用、第二次回退再丢弃该调用，仍保留原种子；不改变读时间和 freshness，后续 Write 不误报未读。
9. 只有 `file_unchanged` 而没有真实正文的历史记录不能被恢复成已读；此前真实 Read 的读时间也不能被后续缓存调用更新时间覆盖。

测试放在 `apps/zcode-cli/packages/core/test/upstreamReadFileStateRewind.test.ts`，必须纳入正式类型检查与本次上游严重修复回归入口。
