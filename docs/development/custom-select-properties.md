# Library 自定义 Select（单选）属性设计规格

> 状态：设计规格已闭合（评审通过，准备实施）。针对 Agentero 论文库（Papers Library）引入类似 Notion 的自定义属性系统（MVP 阶段聚焦 **Select 单选** 属性）。
>
> 后续演进：**Text（自由文本）属性已实现**，与 Select 共用 `custom_props` 的 `property_id -> String` 映射，由属性 `type` 决定取值语义（见 [../frontend/library.md](../frontend/library.md)、[../backend/catalog.md](../backend/catalog.md)）。下文「类型仅限 Select」只描述 MVP 范围。

---

## 1. 目标与范围边界

### 目标
1. **Notion 式交互体验**：
   - 表头右侧支持点击 `+` 快捷新建自定义 Select 属性列。
   - 单元格支持下拉选择已有选项，或直接打字输入新选项名称按回车（Enter）原子新建并选中。
   - 选项支持自定义名称与颜色标签（复用现有的 `TagColorPalette` / 调色板）。
   - 表头提供操作菜单：重命名属性、管理选项池（改名/改色/删除选项）、删除属性列。
2. **纯文件可读、随库同步与可重建承诺（Local-First）**：
   - Vault 级属性定义与选项元数据随库持久化至 `.agentero/properties.json`。
   - 在同步引擎（`features/sync/`）中将 `.agentero/properties.json` 列为同步白名单（作为与 Vault 紧密绑定的随库结构化元数据同步）。
   - 每篇论文的属性赋值作为原生字段写入其 `{paper}/metadata.json`（sidecar）。
   - `catalog.sqlite` 仅作为高性能聚合查询索引；即使删除 `.agentero/catalog.sqlite`，也能仅凭盘上文件完整重建属性定义与所有论文的赋值。

### MVP 范围边界
- **仅支持本地 Vault**：MVP 不承诺远端 Vault（`features/remote/` 经由 `remote_paper_list`）的自定义属性支持；远端 Vault 暂不渲染自定义属性列。
- **类型仅限 Select**：值存储采用强类型的 `option_id`。Multi-Select、Date、Number 等类型保留为后续演进，不在 MVP 架构中做无需调整模型的虚假承诺。
- **排序行为明确为前端就地排序**：MVP 阶段自定义属性列不支持服务端 SQL 排序，仅在前端当前页基于 option 名称进行就地排序（或点击表头进行升降序切换），避免在 SQLite 中使用复杂的 JSON 提取表达式污染 SQL 索引。

---

## 2. 存储模型与双轨一致性保证

### 2.1 Vault 级别属性定义：`.agentero/properties.json` + `custom_properties` 表

为兑现离开应用可读与全库可重建的承诺，Vault 级别的属性定义在盘上保存为 `.agentero/properties.json`，格式如下：

```json
{
  "version": 1,
  "properties": [
    {
      "id": "prop-uuid-1",
      "name": "Priority",
      "type": "select",
      "orderIndex": 0,
      "options": [
        { "id": "opt-1", "name": "P0", "color": "red" },
        { "id": "opt-2", "name": "P1", "color": "yellow" }
      ]
    }
  ]
}
```

#### 同步白名单支持（`features/sync/snapshot.rs`）
在 `is_ignored_name` 中，虽然忽略 `.agentero` 目录下的缓存与中间数据（如 `.agentero/catalog.sqlite`、`.agentero/sync/`），但在快照扫描时，**明确放行 `.agentero/properties.json`**，使其作为随库配置参与版本清单与文件同步，保障多设备间属性定义不丢失。

#### SQLite Schema v10 镜像表
```sql
CREATE TABLE IF NOT EXISTS custom_properties (
    id           TEXT PRIMARY KEY NOT NULL,
    name         TEXT NOT NULL,
    type         TEXT NOT NULL DEFAULT 'select',
    options_json TEXT NOT NULL DEFAULT '[]',
    order_index  INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
```

---

### 2.2 论文级属性值：`PaperRecord` 原生集成与合并规则

为避免普通更新覆盖属性值以及消除 rescan 时时间戳脱节问题，**不设独立的属性值表，直接将自定义属性提升为 `PaperRecord` 的一级公民**：

#### 1. PaperRecord 扩展（`crates/agentero-core/src/features/paper/catalog/papers.rs`）
```rust
pub struct PaperRecord {
    // ... 现有字段 ...
    
    /// 自定义属性赋值：property_id -> option_id (单选)
    #[serde(default)]
    pub custom_props: HashMap<String, String>,
}
```

#### 2. SQLite 表字段（Schema v10）
```sql
ALTER TABLE papers ADD COLUMN custom_props_json TEXT NOT NULL DEFAULT '{}';
```

#### 3. `upsert_paper` 合并规则与写屏障
为了防止调用方传入新构造的 `PaperRecord`（如入库流水线或重新抓取元数据）导致已有的 `custom_props` 被空 map 冲掉：
- 在 `upsert_conn` 内部执行合并策略：若新传入记录的 `custom_props` 为空，而数据库中已有该论文记录且 `custom_props_json` 非空，**自动继承已有的 `custom_props`**。
- 若需要明确清空或修改属性，统一走专用的更新接口 `set_paper_custom_property_value` 或在 `mutate_paper` 的闭包中显式修改。

#### 4. 跨 JSON、SQLite 和 Sidecar 的提交顺序与自愈机制
- **写入顺序**：
  1. 校验 `option_id` 是否确实属于该 `property_id` 的合法选项池中。
  2. 开启 SQLite 事务（`Immediate`），读取当前 `PaperRecord`，更新 `custom_props` 与 `updated_at`，写入 SQLite。
  3. 执行 `atomic_write` 将最新的 `PaperRecord` 写回 `{paper}/metadata.json`。
  4. 提交 SQLite 事务（或在事务成功后写入 sidecar）。
- **Sidecar 写入失败自愈**：
  - 若 disk 写入失败（如只读文件系统或权限问题），记录警告并保留在 SQLite 中。
  - 在后续的后台定期维护或下次论文任意字段写回时，检测 `metadata.json` 的 mtime/内容与 SQLite 的差异并重新补偿刷写。
- **Rescan 重建自愈**：
  - 当整库执行 `paper_rescan` 或重建 catalog 时，以盘上 `.agentero/properties.json` 和每篇论文的 `metadata.json` 为真源全量回灌。
  - 回灌时强制进行**孤儿过滤（Orphan Filtering）**：若 sidecar 中的 `property_id` 或 `option_id` 在当前 `properties.json` 中已不存在，直接过滤丢弃，不载入 SQLite，并自动重写净化的 sidecar。

---

### 2.3 路径变更、移动与删除生命周期闭环

由于 `custom_props_json` 直接作为 `papers` 表的行内字段：
1. **移动（`move_under_path` / `move_with_index`）**：
   - 现有的 `UPDATE papers SET path = ...` 事务天然保持整行完整，包含 `custom_props_json`。
2. **删除（`delete_under_path`）与回收站快照（`list_under_path`）**：
   - `list_under_path` 读出的 `PaperRecord` 快照完整保留 `custom_props`。
   - 回收站恢复调用 `upsert_paper` 重新插入时，属性值原样恢复。
3. **盘上孤儿清理（`prune_missing`）**：
   - 随 `DELETE FROM papers` 一同清理，不存在残留孤儿映射记录。

---

### 2.4 选项变更、删除与新建的值语义

1. **新建选项并选中的原子性**：
   - 提供专用原子 IPC：`catalog_create_option_and_set`，在同一个后端调用中完成：
     1. 追加新选项到 `.agentero/properties.json` 与 SQLite `custom_properties`。
     2. 将该 `option_id` 写入目标论文并刷写 sidecar。
2. **选项删除处理策略**：
   - 当用户在表头管理中删除某个已有选项时：
     1. 从 `.agentero/properties.json` 和 `custom_properties.options_json` 中移除该选项。
     2. 扫描 `papers` 表中引用该 `option_id` 的记录，批量清除该键值。
     3. 批量将受影响论文的 sidecar 进行更新重写（或在重建/加载时由孤儿过滤机制兜底）。
3. **属性列删除**：
   - 从 `.agentero/properties.json` 与 SQLite 中删除该属性定义。
   - 批量更新 SQLite 中包含该 `property_id` 的论文记录，并从前端偏好中移除对应列。

---

## 3. 前端与现有 Library 设置体系集成

### 3.1 动态列 Key 与偏好持久化（`src/lib/settings/store.ts`）

现有 `LIBRARY_COLUMN_KEYS` 为固定静态联合类型，导致 `normalizeLibraryColumns` 会丢弃未知 key。

#### 改造方案：
1. **类型扩展**：
   ```typescript
   export type BuiltinLibraryColumnKey = "title" | "authors" | "date" | "addedAt" | "publication" | "tags" | "id" | "citations";
   export type LibraryColumnKey = BuiltinLibraryColumnKey | `prop:${string}`;
   ```
2. **设置归一化（`normalizeLibraryColumns`）**：
   - 修改过滤逻辑：允许 `typeof key === "string" && key.startsWith("prop:")` 的自定义属性 key 通过归一化校验，保留其宽度 `widthRem` 与可见性 `visible`。
3. **属性删除后的偏好清理**：
   - 当某个属性被删除时，自动触发 settings store 更新，剔除 `key === "prop:${deleted_id}"` 的配置项，防止垃圾配置堆积。

### 3.2 表格渲染管道改造（`library-columns.tsx` 与 `library-paper-row.tsx`）
1. **解耦固定索引**：
   - 将现有 `library-paper-row.tsx` 中直接索引 `COLUMN_META[col.key]` 的写法，改为先从 `COLUMN_META` 取内置列渲染器；若未命中且以 `prop:` 开头，则动态派发至 `CustomPropertyCell` 渲染器。
   - 单元格渲染器接口保持一致：`(paper: PaperLibraryRow, ctx: CellCtx) => ReactNode`。
2. **表头渲染适配（`library-table-header.tsx`）**：
   - 内置列显示常规排序与字段名。
   - 自定义属性列显示属性名称、颜色指示，点击表头弹出操作菜单（重命名、选项颜色配置、删除列）。

---

## 4. 实施阶段计划

### Phase 1: 核心数据层与持久化规范
- [ ] 在 `crates/agentero-core` 中实现 `.agentero/properties.json` 读写模块，并集成至同步快照白名单。
- [ ] 升级 SQLite Schema v10（`papers.custom_props_json` 与 `custom_properties`）。
- [ ] 在 `PaperRecord` 中添加 `custom_props` 字段，实现 `upsert_paper` 继承合并保护与孤儿过滤。
- [ ] 编写覆盖新建选项并赋值、删除选项级联清理、移动与 rescan 的集成测试。

### Phase 2: 后端 IPC 与数据聚合
- [ ] 注册属性定义 CRUD 与 `catalog_create_option_and_set` 原子接口。
- [ ] 验证 `paper_list` 随论文行返回 `custom_props`。
- [ ] 生成前端 bindings。

### Phase 3: 前端交互与设置兼容
- [ ] 调整 `settings/store.ts` 支持 `prop:*` 动态列的宽度与可见性持久化与删除清理。
- [ ] 解耦 `library-paper-row.tsx` 与 `library-columns.tsx` 中的固定索引，支持动态属性列。
- [ ] 实现表头 `+` 新建列与表头属性配置 Popover。
- [ ] 实现单元格 `SelectCell` 组件（搜索、Enter 新建、改色、选中与前端排序）。

### Phase 4: 国际化与验证
- [ ] 补充 `zh-CN` / `en` 国际化文案。
- [ ] 运行 `cargo test`、`pnpm lint` 与 `pnpm build`。
- [ ] 本地验证属性新建、回车建选项、改色、移动论文、重启后数据完整性。
