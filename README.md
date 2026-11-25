# 测试验收（dsh-test-acceptance-preset）

给 DeepSeek Harness 加一个「测试验收」预设：选中后，agent 先问清测试用例在哪、需求文档在哪、输出目录在哪，再按统一格式把测试中发现的问题输出成 Markdown 报告。

之前那套 `AGENT_PROMPT.md` + `README.md` + `问题模板.md` + `校验.ps1` 的作用是「把指令贴给 agent、再手改路径」。现在指令、模板、校验脚本都打包进插件，路径由会话里的问答决定，不需要再手动改 prompt。

## 装好之后怎么用

1. 新建会话时在模式（Agent preset）选择器里选「测试验收」。
2. agent 的第一个动作是问三件事：
   - 测试用例在哪（可选，没有就说没有）
   - 需求文档在哪（可选，没有就说没有）
   - 输出目录在哪（建议放在项目内，例如 `test/首轮`）

   如果这次测的是 Web / H5，还会在同一轮问：有没有测试环境地址、有没有测试账号（含登录方式 / 验证码怎么处理）；小程序问 AppID 与开发者工具登录态，App 问测试包与设备，纯接口问 base URL 与鉴权方式。账号密码只用于执行测试，不会写进报告。
3. 回答后 agent 先盘点环境能力：能不能读代码、项目是 Web / 小程序 / App / 后端、能不能操控浏览器、电脑有没有连手机、能否操作微信开发者工具、接口能不能直连；再按实际能用的手段选测试路径。
4. 然后加载 `test-report` 技能开工；测试用例或需求缺失时不会停工，而是按你的实际要求划定范围，并在报告里注明依据来源。能力缺失也不阻止开工，但最终回复会写清覆盖了哪些端、哪些没覆盖、为什么。
5. 结束后按轮次把报告目录交给开发；需要 Word / Excel 时以 Markdown 为准转换。

## 输出约定（摘要）

- 一条未通过用例 = 一个 Markdown 文件，文件名 `<级别>-<功能类别>-<简要描述>-<状态>.md`，例如 `P1-订单列表-已退款行金额列错位-待修复.md`。
- 状态只用：`待修复` / `修复中` / `待验证` / `已验证` / `已关闭` / `不修复` / `延期`。
- 正文七个必填段落：问题级别、文件目录、问题描述、预期结果、实际结果、初步定位、问题截图。
- 「初步定位」要判断责任方（前端 / 后端 / 前后端都有 / 需求或产品 / 待确认），能看源码或接口响应时必须写成可核查的依据（接口路径 + 关键字段值、源码路径:行号、日志原文），证据不足写 `待确认` 并说明缺什么。
- 截图存 `<输出目录>/截图/`，用相对路径引用；截不了图必须写原因。
- 完整规则在技能里：`skills/test-report/SKILL.md`、`references/output-spec.md`、`references/workflow.md`。

校验（脚本随插件一起装，支持 PowerShell 7 与 Windows PowerShell 5.1）：

```powershell
pwsh -NoProfile -File "<插件目录>/skills/test-report/assets/校验.ps1" -Path "<输出目录>"
# 只有 Windows PowerShell 5.1 时：
powershell -NoProfile -ExecutionPolicy Bypass -File "<插件目录>/skills/test-report/assets/校验.ps1" -Path "<输出目录>"
```

## 它继承 PTC 模式

预设的插件清单以随 DSH 发布的 `ptc` 预设为基础：工具通过 `run_code` 程序调用（`tools.read(...)`、`tools.ask_user_question(...)`、`tools.skill(...)`），与 PTC 模式一致。差异只有两处：

1. `persona` 换成「先问参数、再按规范输出」的模式引导；
2. `skill-filesystem` 额外挂载本包的 `skills/` 目录。

因此 DSH 升级后 `ptc` 预设若有变化，需要把变化同步到 `cordis.patch.yml`。

## 安装

- 图形界面：**Plugins** → **Add plugin**，选择本目录（本地目录安装）。
- 也可以让 agent 用 `plugin_manager` 的 `install_bundle` 指向本目录。
- 装好后在 Plugins 页能看到对应 bundle 行；模式出现在会话的模式选择器里（新建会话时可用；支持切换模式的会话也可以直接切换）。

## 目录结构

```text
dsh-test-acceptance-preset/
├── package.json            # 包清单：dsh.bundle.patch、engines.dsh、导出资源
├── cordis.patch.yml        # 预设声明：persona 引导 + PTC 工具清单 + 挂载技能目录
├── locale/{en,zh}.json     # 插件标题与说明
├── icon.svg                # 插件图标
├── docs/                   # 插件详情页
└── skills/test-report/
    ├── SKILL.md            # 技能入口：参数确认、输出单位、硬性规则、模板与校验
    ├── references/
    │   ├── output-spec.md  # 文件名 / 状态 / 七段结构 / 级别 / 截图 / 依据来源
    │   └── workflow.md     # 执行、定级合并、复测、校验、自检清单
    └── assets/
        ├── 问题模板.md      # 单条报告的复制源
        ├── 校验.ps1        # 校验脚本（UTF-8 BOM，兼容 5.1）
        └── 示例/           # 一份示例报告与示意截图
```

## 与旧模板的关系

`template/` 里那套人工流程仍然可以对照阅读，但不要再手工贴进会话：

- `AGENT_PROMPT.md` 的「本次任务参数」改由会话问答确定；
- `README.md` 的规范拆进 `references/`，通用化了端、页面、用例来源等字段；
- `问题模板.md`、`校验.ps1` 原样收进 `assets/`，校验脚本补了文件名长度、保留名、标题重复和状态枚举检查。

## 通用指令注入

插件详情页有一个「通用指令注入」区：维护若干小节（标题 + 内容 + 启用开关），每节的内容会拼进「测试验收」会话的系统提示，像 AGENTS.md 一样常驻，不用每轮重贴。

- 只对「测试验收」会话生效，普通会话不受影响。
- 新会话行有「指令小节 n/m」按钮：点开只切换**本次会话**生效的范围；这次的选择会记成下次新会话的默认。
- 内容按小节顺序注入，没打开的小节不注入；删掉小节时，会话里对它的引用一并清理。
- 数据存在 `$DSH_HOME/storages/dsh-test-acceptance-preset/sections.json`（`$DSH_HOME` 缺省 `~/.dsh`），与工作区无关，跨项目共用一份；**明文保存**，不要填生产密码。
- 每节内容上限 4000 字，注入总量上限 12000 字，超出按顺序截断。

## 目录结构（补充）

```text
lib/
├── index.js       # Host 插件：/api/test-acceptance-sections/* 读写接口
├── store.js       # JSON 读写、原子写、缓存、会话选择与注入文本
└── sections.js    # 预设子插件：往系统提示注入小节内容
client/
└── client.js      # 插件页配置面板 + 会话行按钮 + 会话面板
```
