# MindZJ AI 文献阅读器改造方案

> 状态：架构设计草案，尚未进入功能实现  
> 适用版本：基于 MindZJ 0.2.2 当前代码  
> 目标：把现有的本地 Markdown 笔记工具扩展为本地优先、可追溯、支持多模型的 AI 文献阅读工具

## 1. 项目目标

改造后的 MindZJ 应同时承担四个角色：

1. 本地文献库：导入和管理 PDF、图片、视频及其他补充材料。
2. PDF 阅读器：保持原始论文版面，支持段落定位、引用跳转和原文高亮。
3. AI 阅读助手：围绕当前论文进行问答、翻译、摘要和要点提炼。
4. 研究资料库：将翻译、摘要、证据位置和对话记录持久化在本地。

系统继续遵循 local-first 原则。原始论文和附件保存在用户选择的 Vault 中，AI 派生数据保存在 Vault 内的本地数据库中。除用户主动调用在线模型外，不应上传任何论文内容。

## 2. 功能范围

### 2.1 文献导入与分类

- 导入 `.pdf` 论文。
- 一并导入论文相关图片、视频和补充材料。
- 用户可创建真实文件夹，例如“生物化学”“脑机接口”等，对论文进行分类。
- 支持移动、重命名、删除和从系统文件管理器打开。
- 每篇论文使用稳定 UUID 标识，移动文件夹后不会丢失翻译、摘要和对话。
- 使用文件内容哈希判断文件是否变化，避免重复解析和重复调用模型。

### 2.2 PDF 阅读与 AI Chat

- PDF 在主阅读区中显示，右侧可展开 AI Chat 面板。
- 初次打开论文时完成解析并建立论文上下文。
- Chat 可以回答全文问题，也可以基于当前页、当前选择或指定段落提问。
- AI 回答应尽量附带段落引用。
- 点击引用可跳转到对应页面并高亮原文。
- 支持 OpenAI、Anthropic、DeepSeek、Ollama 等 Provider。

### 2.3 预翻译与段落卡片

- 用户可以启动整篇论文的预翻译任务。
- 翻译以段落为最小持久化单位，而不是保存为一大段全文。
- PDF 页面外侧显示与段落对齐的摘要卡片。
- 卡片正文是该段落的总要点。
- 卡片旁显示一个或多个分要点标签。
- 悬浮分要点标签时，高亮其对应的一个或多个原文片段。
- 悬浮或展开卡片时显示该段落的中文翻译。
- 翻译、摘要和证据定位结果全部缓存在本地，可离线再次阅读。

## 3. 可行性结论

整体方案可行，现有 MindZJ 可以继续作为基础，不需要推倒重写。

| 能力 | 可行性 | 说明 |
| --- | --- | --- |
| PDF 和附件导入 | 高 | 可复用现有 Vault、文件树和文件监听能力 |
| 真实文件夹分类 | 高 | 继续使用本地文件系统目录作为用户可见分类 |
| PDF 阅读器 | 高 | 前端集成 PDF.js 即可完成渲染、文本层和坐标转换 |
| AI Chat | 高 | 可从现有 AI HTTP 代理扩展成统一 Provider 层 |
| 整篇预翻译 | 高 | 需要后台任务、批处理、缓存、暂停和重试 |
| 段落摘要卡片 | 中高 | 依赖可靠的段落分割、阅读顺序和页面锚点 |
| 标签到原文高亮 | 中高 | 需要模型输出严格的段落 ID 和字符区间 |
| 扫描版 PDF | 中 | 需要 OCR，且双栏、表格、公式会增加版面恢复难度 |

最大的技术风险不是调用模型，而是建立稳定的定位链：

```text
PDF 页面坐标
    ↕
原文段落与字符区间
    ↕
翻译、总要点、分要点
    ↕
AI 回答引用与页面跳转
```

这条定位链必须成为系统的数据主轴。Chat、翻译卡片、摘要标签和证据高亮都应复用它。

## 4. 设计原则

### 4.1 原始文件与派生数据分离

- PDF、图片、视频等原始资料以普通文件保存在 Vault。
- 段落、坐标、翻译、摘要、聊天记录等结构化数据保存在 SQLite。
- 缩略图和可重建缓存放入 `.mindzj/cache`。
- 删除缓存不应影响原始论文。
- 数据库损坏时，系统应能够根据原始 PDF 重新建立派生数据。

### 4.2 稳定 ID，不依赖路径

- `paper_id` 使用 UUID。
- `paragraph_id` 在一次 PDF 内容版本中保持稳定。
- 数据库使用 ID 关联，不使用文件路径作为主键。
- 路径移动只更新 `papers.relative_path`。

### 4.3 AI 结果必须可追溯

每个翻译、摘要或回答应保存：

- Provider 和模型名称；
- Prompt 版本；
- 源段落内容哈希；
- 生成时间；
- Token 用量与可选费用；
- 引用的段落 ID 和字符区间；
- 处理状态与错误信息。

### 4.4 所有长任务可恢复

解析、OCR、全文翻译和全文摘要都不能依赖前端页面持续打开。任务状态必须持久化，应用重启后可以继续执行。

## 5. 总体架构

目标架构图：

- [交互式 HTML 架构图](../docs/AI_RESEARCH_READER_ARCHITECTURE.html)
- [架构图 JSON 源文件](../docs/AI_RESEARCH_READER_ARCHITECTURE.json)

逻辑架构如下：

```text
SolidJS 前端
├── 文献库与文件夹
├── PDF.js 阅读工作台
│   ├── PDF 页面
│   ├── 文本坐标层
│   ├── 证据高亮层
│   └── 段落卡片 gutter
└── AI Chat 侧栏
        │
        │ Tauri invoke / event
        ▼
Rust Tauri API
├── 文献库 API
├── PDF 处理 API
├── AI API
└── 后台任务 API
        │
        ▼
Rust 领域层
├── 文档解析引擎
├── 段落和版面模型
├── AI 编排与 Provider 适配
├── 上下文构建器
└── 持久化任务执行器
        │
        ├── Vault 文件存储
        ├── SQLite 派生数据库
        └── 外部或本地模型
```

## 6. 现有 MindZJ 能力复用

### 6.1 可以直接复用

- Tauri 桌面壳和跨平台打包。
- Vault 路径校验、原子写入和文件操作。
- 文件树、目录创建、移动、删除。
- 文件系统 watcher。
- 标签页、分屏、多窗口框架。
- 设置、主题、多语言和快捷键。
- 当前的 AI HTTP 请求代理。
- 系统 Keyring 依赖。

### 6.2 需要扩展

- 文件路由：Markdown 文件进入 Markdown 工作台，PDF 进入 PDF 工作台。
- Vault Store：增加论文、附件和处理状态。
- AI Store：从界面状态升级为论文上下文、对话和任务状态管理。
- Rust API：增加文献、PDF、数据库、任务和结构化 AI 输出接口。
- 搜索：增加论文全文和元数据搜索。

### 6.3 需要重点重构

- 当前 `App.tsx` 职责过多，应拆分应用壳、Markdown 工作台和 PDF 工作台。
- 当前 AI 请求逻辑应重构为 Provider Adapter，而不是由前端拼装不同厂商请求。
- 当前搜索内核实际是内存字符串搜索，文献版本建议使用 SQLite FTS5，后续再加入向量检索。
- 当前插件代码通过 `new Function` 在主 WebView 中执行。在插件隔离完成前，文献版本应默认禁用不受信任的第三方插件。

## 7. 推荐目录结构

### 7.1 前端

```text
src/
├── workspaces/
│   ├── MarkdownWorkspace.tsx
│   └── LiteratureWorkspace.tsx
├── components/
│   ├── library/
│   │   ├── LiteratureTree.tsx
│   │   ├── PaperCard.tsx
│   │   └── ImportDialog.tsx
│   ├── pdf/
│   │   ├── PdfWorkspace.tsx
│   │   ├── PdfDocumentView.tsx
│   │   ├── PdfPage.tsx
│   │   ├── ParagraphOverlay.tsx
│   │   ├── ParagraphGutter.tsx
│   │   └── EvidenceHighlight.tsx
│   └── ai/
│       ├── PaperChatPanel.tsx
│       ├── CitationLink.tsx
│       └── ProcessingStatus.tsx
└── stores/
    ├── literature.ts
    ├── pdfReader.ts
    ├── paperChat.ts
    └── processingJobs.ts
```

### 7.2 Rust 后端

```text
src-tauri/src/
├── api/
│   ├── literature_api.rs
│   ├── pdf_api.rs
│   ├── ai_api.rs
│   └── job_api.rs
├── literature/
│   ├── library.rs
│   ├── database.rs
│   ├── migrations.rs
│   ├── pdf_ingestion.rs
│   ├── paragraph_layout.rs
│   ├── evidence.rs
│   └── jobs.rs
└── ai/
    ├── provider.rs
    ├── context_builder.rs
    ├── structured_output.rs
    ├── openai.rs
    ├── anthropic.rs
    ├── deepseek.rs
    └── ollama.rs
```

## 8. Vault 文件组织

建议采用“论文包”结构：

```text
Vault/
├── 生物化学/
│   └── Protein Folding 2025/
│       ├── paper.pdf
│       ├── figures/
│       │   ├── figure-1.png
│       │   └── figure-2.png
│       ├── media/
│       │   └── experiment.mp4
│       └── supplements/
│           └── supplementary.pdf
├── 脑机接口/
└── .mindzj/
    ├── literature.db
    ├── cache/
    │   ├── thumbnails/
    │   └── page-images/
    └── exports/
```

第一版允许一个论文目录拥有一个主 PDF。后续可以支持一个研究条目关联多个 PDF。

## 9. 核心数据模型

### 9.1 Paper

```ts
interface Paper {
  id: string;
  relativePath: string;
  contentHash: string;
  title?: string;
  authors?: string[];
  doi?: string;
  publicationYear?: number;
  pageCount: number;
  parseStatus: "pending" | "processing" | "ready" | "failed";
  createdAt: string;
  updatedAt: string;
}
```

### 9.2 Paragraph

```ts
interface Paragraph {
  id: string;
  paperId: string;
  pageNumber: number;
  readingOrder: number;
  sectionId?: string;
  originalText: string;
  sourceHash: string;
  boundingBoxes: Rect[];
}
```

一个段落可能由多个文本块组成，也可能跨页，因此 `boundingBoxes` 必须是数组。

### 9.3 Summary Point 和 Evidence

```ts
interface SummaryPoint {
  id: string;
  paragraphId: string;
  label: string;
  evidenceRefs: EvidenceRef[];
}

interface EvidenceRef {
  paragraphId: string;
  startOffset: number;
  endOffset: number;
}
```

同一个分要点可以对应多个 `EvidenceRef`，并且可以引用不同段落。

## 10. SQLite 表设计

建议至少包含以下表：

### 10.1 原始资料索引

- `papers`
- `paper_assets`
- `pages`
- `sections`
- `paragraphs`
- `paragraph_boxes`

### 10.2 AI 派生数据

- `paragraph_translations`
- `paragraph_summaries`
- `summary_points`
- `evidence_refs`
- `paper_summaries`
- `model_runs`

### 10.3 对话数据

- `chat_sessions`
- `chat_messages`
- `message_citations`

### 10.4 任务与索引

- `processing_jobs`
- `job_items`
- `schema_migrations`
- `paragraphs_fts`，使用 SQLite FTS5。

所有翻译和摘要表都应包含 `source_hash`、`provider`、`model` 和 `prompt_version`。当原文或 Prompt 版本变化时，可以准确判断哪些结果需要重新生成。

## 11. PDF 导入和处理链

```text
用户选择 PDF 与附件
        │
        ▼
复制到目标分类目录
        │
        ▼
计算文件哈希并创建 Paper 记录
        │
        ▼
PDF.js 提取文本项、字体和页面坐标
        │
        ▼
恢复阅读顺序并识别段落、标题、页眉页脚
        │
        ▼
保存页面、段落和 bounding boxes
        │
        ├── 建立 FTS5 索引
        ├── 生成缩略图
        └── 创建可选的预翻译任务
```

第一阶段只保证对“可复制文字的 PDF”有良好效果。扫描版 PDF 进入 `requires_ocr` 状态，后续阶段再接入 OCR。

## 12. 段落识别策略

PDF 通常没有真正的段落结构，只包含散落的文字元素，因此需要根据版面推断：

1. 按页面收集文字元素及坐标。
2. 根据基线、字体、字号和水平间距合并为行。
3. 识别单栏或双栏结构。
4. 根据行间距、缩进和标点合并为段落。
5. 识别并排除页眉、页脚和页码。
6. 单独标记标题、图注、表格和公式区域。
7. 给段落分配稳定的阅读顺序和页面矩形。

第一版不应追求完美理解所有表格和公式，应优先保证普通正文段落稳定。

## 13. PDF 阅读界面

推荐采用三层结构：

```text
PDF Canvas 层       显示原始页面
PDF Text Layer      提供文字选择和字符位置
MindZJ Overlay 层   绘制证据高亮、引用状态和交互
```

页面右侧增加 `ParagraphGutter`：

- 每张卡片通过对应段落的首个 bounding box 计算纵向锚点。
- 多张卡片发生碰撞时，使用 lane layout 向下错位。
- 卡片与原文之间使用细连接线。
- 未进入可视区域的页面和卡片应虚拟化，避免长论文卡顿。
- 点击卡片固定展开翻译；悬浮仅作快速预览。
- 悬浮分要点时，根据 `EvidenceRef` 映射到字符矩形并高亮。

## 14. AI Provider 抽象

不同模型对原生 PDF、图片、多模态、文件上传和 JSON 输出的支持不一致，业务层不能直接依赖某家 API。

Rust 中建议定义统一接口：

```rust
trait AiProvider {
    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse>;
    async fn structured_generate<T>(&self, request: StructuredRequest)
        -> Result<T>;
    async fn upload_document(&self, file: DocumentInput)
        -> Result<Option<RemoteDocumentRef>>;
    async fn embed(&self, texts: &[String])
        -> Result<Vec<Vec<f32>>>;
}
```

Provider Capability 应明确描述：

- 是否支持原生 PDF；
- 是否支持图片输入；
- 是否支持结构化 JSON；
- 上下文窗口；
- 单次最大输出；
- 是否支持 Prompt/上下文缓存；
- 是否为本地模型。

API Key 使用系统 Keyring 保存，数据库仅保存 Provider 配置和是否已配置密钥。

## 15. 论文上下文构建

“打开论文时把 PDF 作为上下文注入”在产品层成立，但内部需要按 Provider 能力分三种执行方式：

1. Provider 支持文件上传：上传原 PDF，并缓存远端文件 ID。
2. Provider 不支持 PDF：使用提取后的结构化文本。
3. 论文超过上下文窗口：使用当前页、选中内容、相关段落检索和论文概要构建上下文。

推荐 Chat 上下文顺序：

```text
系统提示词
+ 论文元数据
+ 论文目录和全局摘要
+ 用户当前可见页面
+ 用户选中的原文
+ 检索出的相关段落
+ 最近对话历史
```

回答输出应带有结构化引用，例如：

```json
{
  "answer": "……",
  "citations": [
    {
      "paragraph_id": "p-103",
      "start_offset": 42,
      "end_offset": 96
    }
  ]
}
```

前端根据引用定位并高亮原文。

## 16. 预翻译和摘要生成链

```text
用户启动预翻译
      │
      ▼
按章节和 Token 上限组织段落批次
      │
      ▼
提交翻译任务
      │
      ├── 检查本地缓存
      ├── 调用 Provider
      ├── 验证 JSON Schema
      ├── 检查 paragraph_id
      ├── 检查 evidence 字符区间
      └── 写入 SQLite
      │
      ▼
通过 Tauri event 增量刷新当前页面卡片
```

翻译、总要点和分要点可以一次生成，但数据库中仍需分开保存。这样用户可以重新生成摘要而不覆盖已有翻译。

模型输出必须经过以下验证：

- JSON Schema 合法；
- 所有段落 ID 存在；
- 字符区间不越界；
- 引用文本与源段落匹配；
- 不接受模型凭空生成的段落 ID；
- 验证失败时进行一次自动修复，再失败则进入人工可重试状态。

## 17. 本地任务队列

任务状态机：

```text
pending → running → completed
             │
             ├── paused → pending
             ├── cancelled
             └── failed → retrying → running
```

任务类型包括：

- `parse_pdf`
- `ocr_pdf`
- `generate_thumbnail`
- `translate_paragraphs`
- `summarize_paragraphs`
- `build_paper_summary`
- `build_embeddings`

任务系统需要支持：

- 应用重启后恢复；
- 暂停、取消和单批重试；
- Provider 限流和指数退避；
- 并发数控制；
- Token 和费用统计；
- 按 `source_hash + prompt_version + model` 缓存；
- 前端实时进度事件。

## 18. Tauri API 草案

```text
import_paper
attach_paper_asset
list_papers
move_paper
get_paper
get_paper_pages
get_page_paragraphs
get_paragraph_analysis
start_pdf_processing
start_pretranslation
pause_job
resume_job
cancel_job
retry_job
list_jobs
create_chat_session
send_paper_chat_message
get_chat_history
```

事件建议：

```text
paper-processing-progress
paragraph-analysis-ready
paper-file-changed
job-status-changed
chat-token-received
```

## 19. 安全与隐私

- 在线模型调用前明确显示本次将发送哪些内容。
- 对 Provider 配置增加“允许上传完整 PDF”开关。
- 默认只向模型发送构建后的最小上下文。
- API Key 进入系统 Keyring，不写入论文目录。
- 日志不得记录 API Key、完整论文内容或完整模型请求。
- 数据库可记录请求哈希，但不应默认保存敏感 HTTP Header。
- 本地 Ollama 模式应允许完全离线运行。
- 第三方插件隔离完成前，不允许不受信任插件直接接触文献数据库或论文全文。

## 20. 异常与降级策略

### 20.1 PDF 无文本层

- 标记为 `requires_ocr`。
- 允许用户正常查看 PDF。
- Chat 和翻译入口提示需要 OCR。

### 20.2 段落顺序异常

- 允许用户切换到“页面文本”模式。
- 保存原始 PDF 文本项，便于重新运行新版解析器。
- 后续允许用户手工合并或拆分段落。

### 20.3 Provider 调用失败

- 已完成批次立即落库。
- 失败批次进入重试队列。
- 切换模型后可只处理失败批次。

### 20.4 论文文件被外部修改

- watcher 检测文件变化。
- 重新计算哈希。
- 保留旧分析版本，不立即删除。
- 提示用户选择重新解析或继续查看旧结果。

## 21. 分阶段实施计划

### 阶段 0：基础重构

目标：为 PDF 工作台建立清晰边界。

- 拆分 `App.tsx`。
- 建立按文件类型选择 Workspace 的路由。
- 建立 SQLite 连接、迁移机制和 repository 层。
- 将 AI 请求重构为 Provider 接口。
- 建立后台任务状态模型。

验收标准：现有 Markdown 功能无回归，应用可以打开一个空的 PDF Workspace。

### 阶段 1：最小可用阅读链路

目标：完成第一条端到端功能。

- 导入文字型 PDF。
- 创建和移动分类文件夹。
- PDF.js 渲染与基本阅读。
- 提取页面文字和坐标。
- 建立 Paper、Page、Paragraph 数据。
- 实现基础全文搜索。

验收标准：导入一篇普通双栏论文后，可以阅读、搜索，并在点击搜索结果时跳转到对应页面。

### 阶段 2：预翻译

目标：生成并缓存段落级中文翻译。

- 支持至少一个在线 Provider 和 Ollama。
- 建立持久化任务队列。
- 分批翻译并保存结果。
- 页面右侧显示段落翻译卡片。
- 支持暂停、恢复和失败重试。

验收标准：关闭并重新打开应用后，已完成翻译仍然存在，未完成任务可以继续。

### 阶段 3：摘要标签与证据高亮

目标：完成用户设想中的核心交互。

- 生成段落总要点。
- 生成一个或多个分要点。
- 保存多段 EvidenceRef。
- 悬浮标签高亮一个或多个原文片段。
- 点击标签固定高亮并滚动定位。
- 增加结构化输出验证和修复。

验收标准：所有显示的分要点都能追溯到有效原文范围，不允许无定位结果直接进入正式卡片。

### 阶段 4：论文 AI Chat

目标：实现带引用的论文问答。

- 建立论文上下文构建器。
- 支持当前页、选中段落和全文问题。
- 支持流式回答。
- 保存会话与消息。
- 回答引用可以跳转并高亮原文。
- 针对长论文加入 FTS 检索式上下文。

验收标准：回答引用可验证，重新打开论文后聊天记录和引用仍然有效。

### 阶段 5：高级文献能力

- OCR 和扫描件支持。
- 图片、图表和多模态理解。
- 表格与公式专项解析。
- 向量检索。
- DOI 和元数据自动识别。
- BibTeX、RIS 等引用格式。
- 跨论文问答和研究主题工作区。

## 22. 推荐的实际开发顺序

为了尽早验证最困难的交互，第一轮开发应采用垂直切片，而不是先铺满所有后台模块：

1. 建立数据库和 migration。
2. 导入一篇 PDF 并创建 Paper 记录。
3. 使用 PDF.js 显示 PDF。
4. 提取一个页面的文本项和坐标。
5. 将该页合并成段落并存入数据库。
6. 在页面右侧显示与段落对齐的静态卡片。
7. 用一个固定模拟分要点验证悬浮高亮。
8. 接入一个模型生成真实翻译、摘要和 EvidenceRef。
9. 将单页处理扩展为整篇后台任务。
10. 最后加入 Chat 和多 Provider。

这个顺序能最早暴露坐标映射、卡片布局和证据高亮问题；这些问题比普通 AI API 接入更决定产品是否成立。

## 23. 测试策略

### 23.1 单元测试

- 路径移动与稳定 ID。
- PDF 坐标归一化和缩放转换。
- 行合并与段落识别。
- Evidence 字符区间校验。
- Prompt 缓存键生成。
- Provider 响应标准化。
- 任务状态转换。

### 23.2 集成测试

- PDF 导入到数据库落库的完整链路。
- 应用重启后的任务恢复。
- 外部移动 PDF 后的数据关联。
- 翻译失败后的批次重试。
- Chat 引用跳转。

### 23.3 PDF 测试语料

测试集至少包含：

- 单栏论文；
- 双栏论文；
- 中英文混排；
- 大量公式；
- 大量表格；
- 跨页段落；
- 扫描版 PDF；
- 带旋转页面的 PDF；
- 超长论文；
- 加密或损坏的 PDF。

## 24. 关键产品决策

实现前建议固定以下默认选择：

- PDF 前端渲染使用 PDF.js。
- 第一版只承诺文字型 PDF。
- SQLite 是派生数据的唯一事实来源。
- 原始 PDF 和附件始终保留为普通文件。
- 文件夹是用户可见分类；标签作为第二分类维度后续加入。
- AI 生成结果必须包含可验证证据。
- 第一版检索使用 SQLite FTS5，不急于加入向量数据库。
- 第一版先完成一个在线模型和 Ollama，再扩展其他 Provider。
- Prompt 和数据库都必须有版本号。

## 25. 第一里程碑建议

第一个可交付里程碑建议定义为：

> 用户能把一篇文字型 PDF 导入任意分类文件夹，在 MindZJ 中阅读；系统能够识别页面段落，在右侧显示一个段落卡片，并且悬浮卡片中的模拟标签时准确高亮对应原文。

这个里程碑暂时不需要真实翻译或 Chat。它先证明整个产品最关键、风险最高的“段落—坐标—卡片—高亮”链路。链路稳定后，再接入大模型会比较顺畅。

## 26. 后续行动

建议下一步进入阶段 0 和阶段 1 的技术设计，产出：

1. SQLite 第一版 schema 和迁移文件。
2. PDF Workspace 前端组件边界。
3. Tauri 文献 API 请求/响应类型。
4. PDF 导入与解析的端到端时序图。
5. 第一个垂直切片的任务清单和验收测试。

