# 删除单条工作区记忆

## 背景

记忆列表此前只能"看"和"用外部编辑器打开",**UI 里没有任何删除入口**。这在这个功能里不是可有可无的补充,而是维持它可用的必要手段:

- `MEMORY.md` 是每轮请求都会注入的索引,总额度只有 200 行 / 25,000 字符,**只增不减必然静默截断**,靠后的记忆会无声失效;
- 写错的记忆会以"覆盖默认行为"的高优先级持续污染之后所有会话,而用户此前只能去外部编辑器改;
- 模型侧本来就有 forget 能力(记忆提示词里写了「If they ask you to forget something, find and remove the relevant entry」),用户侧却完全没有对应入口。

本次补上"删除单条记忆"。

## 产品规则

1. 记忆文件行新增删除按钮(悬停/聚焦时出现),删除**单条**记忆文件。
2. **破坏性且不可恢复**——不进回收站、不在 git 管理下。必须二次确认,确认文案带上文件名(复用项目统一的 `useConfirmDialog`,`confirmVariant: "destructive"`)。
3. 删除的同时**清理 `MEMORY.md` 里指回该文件的索引行**。索引每轮注入,留着指向已不存在文件的指针会直接误导模型。只删除「Markdown 链接目标等于该文件名」的行(允许 `./` 前缀),其余内容逐字保留;没有匹配行时**不写文件**(避免无意义地改动用户内容)。
4. 删除 `MEMORY.md` 自身时**不做索引清理**——它就是索引,不存在"指回自己"的问题。
5. 只删文件,不删工作区目录:工作区最后一个文件被删除后它自然从列表消失(目录列表本来就跳过没有记忆文件的工作区)。
6. 删除成功后刷新目录列表;若被删除的文件正在预览弹窗中打开,关闭预览。
7. 作用域严格限定在**当前选中工作区内的指定文件**,不提供跨工作区或批量删除。
8. 失败不静默:toast 报出具体原因,列表保持原样,不假装成功。

## 状态所有者

- **删除动作**:由 `MemorySettingsSection` 发起(它持有 `memoryService` 与当前选中的 workspaceId),预览弹窗不参与。
- **目录列表**:仍由 `MemorySettingsSection` 的 catalog 状态持有;删除后走既有的 `refreshCatalog()`,不就地改数组,避免与并发刷新产生两套事实。
- **索引清理**:由服务层完成,属于"删除这条记忆"这个动作的一部分,不拆给 UI 做多次调用(否则会出现"文件删了、索引没清"的中间态)。

## 接口

```ts
// packages/services/src/memory/memory.ts
interface IMemoryService {
  // ...已有 listProjectMemories / describeProjectMemoryRoots / readProjectMemoryFile
  /** 删除一条 Project Memory 文件,并清理索引中对它的引用。 */
  deleteProjectMemoryFile(params: { workspaceId: string; fileName: string }): Promise<void>;
}
```

### 安全约束

删除路径复用读取路径的全部校验,不新增宽松分支:

- `isValidPathSegment` 校验 workspaceId / fileName,`isProjectMemoryFileName` 校验扩展名——拒绝 `..`、路径分隔符;
- `requirePlainDirectory` 逐层拒绝符号链接(projectsRoot / workspaceRoot / memoryRoot);
- `requireExactProjectMemoryFile` 做大小写敏感的存在性匹配,避免大小写不敏感文件系统上的别名绕过;
- `assertContainedProjectMemoryPath` 确认目标仍在 projectsRoot 内;
- 清理索引时对 `MEMORY.md` 同样跑一遍校验后才 `atomicWriteText` 写回。

`unlink` 只作用于已校验为普通文件的路径;即使校验与删除之间被换成符号链接,`unlink` 删除的也是**链接本身**而不是它指向的外部文件,不会造成越界删除。

索引行匹配是纯字符串逻辑,抽成 `packages/services/src/memory/index-entries.ts` 的纯函数以便单测(该模块只有 type import,可被测试直接加载)。

## 验收场景

1. 悬停文件行 → 出现删除按钮;点击 → 弹出破坏性确认,含文件名。
2. 取消确认 → 不发任何请求,文件与索引都不变。
3. 确认删除某个主题文件 → 该文件消失、列表刷新,`MEMORY.md` 中指向它的那行被移除,其余行逐字不变。
4. 删除 `MEMORY.md` 自身 → 只删索引文件,不产生"清理索引"的写入。
5. 删除某工作区最后一个记忆 → 该工作区从列表消失;若它正被选中,选中态回退到其它工作区或空态。
6. 被删除的文件正在预览 → 预览关闭。
7. 删除失败(例如文件已被外部删除) → toast 报原因,列表不变。
8. 传入越界路径(`../x.md`、含分隔符、非 `.md`)→ 服务层拒绝,不触碰文件系统。

## 已知限制

- 不提供"清空该工作区全部记忆":那是另一档破坏性操作,需要独立的确认与备份语义,本次不做。
- 不做回收站/撤销:删除不可恢复,由二次确认承担。
- 不改写主题文件之间的 `[[name]]` 互链:删除 A 后,其它文件里指向 A 的链接会留下(与 `MEMORY.md` 的索引不同,这些链接不是每轮注入的内容,且模型被明确要求可以留下未匹配的链接)。
- 已删除的记忆不会被主动重新生成;但记忆抽取代理在后续会话中可能重新记录同一事实,这是预期行为。
