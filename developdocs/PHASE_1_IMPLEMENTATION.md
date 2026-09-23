# 阶段 1：最小可用 PDF 阅读链路

## 完成范围

- 导入文字型 PDF，并在文献数据库中建立 `Paper` 记录。
- 复用 Vault 文件树创建、重命名和移动分类文件夹。
- 文件或文件夹移动后，级联更新论文的 `relative_path`，保留已有索引。
- 使用 PDF.js 渲染页面，支持翻页、页码跳转、缩放和适合宽度。
- 提取 PDF 文本项、字体、页面坐标，并生成可选择的透明文本层。
- 恢复单栏/双栏阅读顺序，按行距、字体变化、缩进、列表和短行识别段落。
- 将 `Paper / Page / Paragraph / ParagraphBox` 写入 Vault 内的 SQLite。
- 使用 SQLite FTS5 建立段落全文索引；对中文和子串查询提供 `LIKE` 回退。
- 搜索结果显示页码和上下文，点击后跳转页面并高亮对应原文行。
- 无文本层的 PDF 标记为 `requires_ocr`，不影响原始页面阅读。

## 参考与适配

版面分析参考了 `F:\Work\Vibero` 中先恢复字符/行结构、再判断段落边界的思路，重点参考：

- 文本项去重；
- 按基线和视觉位置恢复行；
- 通过行间距、字体变化和短行识别段落；
- 保存文本到页面坐标的映射。

MindZJ 没有复制 Vibero 的定制 PDF.js Worker，而是基于标准 `pdfjs-dist` 的 `getTextContent()` 输出重新实现为纯 TypeScript 模块。这样保持现有 Vite、SolidJS 和 Tauri 架构，并且版面算法可以独立测试。

## 数据流

```text
打开 PDF
  -> 后端校验文件哈希并读取 Paper 状态
  -> PDF.js 渲染当前页
  -> 首次打开时逐页提取 TextItem
  -> layout.ts 恢复行、栏和段落
  -> index_pdf_document 一次事务写入 SQLite
  -> paragraphs_fts 建立全文索引
  -> 搜索结果返回页码、段落和归一化坐标
  -> 阅读器跳页并高亮原文
```

归一化坐标统一使用页面左上角为原点的 `[0, 1]` 范围，因此缩放后不需要重新计算数据库坐标。

## SQLite 迁移

`literature.db` schema version 从 1 升级到 2，新增：

- `pages`
- `paragraphs`
- `paragraph_boxes`
- `paragraphs_fts`

解析结果属于可重建派生数据。PDF 内容哈希改变时，旧页面、段落和 FTS 数据会被清除并重新生成。

## 验证

- TypeScript 类型检查通过。
- 前端单元测试 43 项通过，其中包含双栏顺序、重复文本项和跨行连字符测试。
- Rust 单元测试覆盖迁移、段落落库、FTS 搜索、文件移动和文件夹路径级联。
- Vite 生产构建通过。
- Tauri 开发版能够完成编译并启动。

## 当前边界

- 第一版针对具有可复制文本层的常规学术 PDF。
- 扫描版只标记 `requires_ocr`；OCR 属于后续阶段。
- 极复杂混排、跨栏图注、旋转文字和数学公式的阅读顺序仍需用测试语料持续校准。
- 首次整篇解析由 PDF Workspace 发起；可恢复的后台解析队列将在后续任务系统迭代中接管。
