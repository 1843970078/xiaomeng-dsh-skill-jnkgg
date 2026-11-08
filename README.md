# dsh-skill-jnkgg · 技能库管家

给 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 用的技能库管理插件：
把**任意目录**里的 Agent Skills（`SKILL.md` 格式）挂进 DSH 技能体系——目录限量展示、正文按需加载、
隐藏条目不删除、中文关键词直达。

> jnkgg = **j**i **n**eng **k**u **g**uan **j**ia（技能库管家的拼音首字母）

## 解决什么问题

DSH 原生只扫 `~/.dsh/skills/`，且每个技能**每轮**都在系统提示词里占一行摘要。
想挂一个 77 条的大型技能库（比如
[awesome-gamedev-agent-skills](https://github.com/gamedev-skills/awesome-gamedev-agent-skills)），
全进目录 = 每轮多烧几千 token，还挤掉真正相关的技能。

本插件（零 npm 依赖，纯 `SKILL.md` + 原生 API）：

| 机制 | 效果 |
|---|---|
| 向 `ctx.skills` 注册 SkillProvider | 外部目录的技能进宿主技能体系，`/名字` 与 `skill` 工具原生可用 |
| 每库 `maxVisible` 限量 | 只有前 N 条 `modelInvocable`；**超出的不删除**，降级为 user-invocable |
| 正文懒加载 | `get()` 时才读盘，目录里永远只有摘要 |
| **库入口 router** | 每库自动挂一条 `<库名>-library`，描述写清"这个库是干什么的"，一句话就能拉起整库索引 |
| **自动分析库主题** | 不填关键词也行：插件自己读全库，统计出主题词（零 LLM 零网络） |
| **中文关键词映射** | 说「二段跳」「音效」「卡壳」也能落到 `jump`/`audio`/`performance` |
| **主题分散选取** | 混杂库里按主题分桶轮流取，小主题不会被大主题淹没 |
| 可视化设置面 | 状态总览 / 库管理 / Token 预算 / 技能浏览（带可见性徽标）/ 日志 |

**"省 token 又不丢不遗忘"**：隐藏 ≠ 删除。用 `/技能名` 直接调用、`skill_jnkgg` 的 `search`
或 `load`、库入口索引，三条路都能取回。

## 安装

```bash
# 1. 在 DSH 的 profile 目录里 link 本仓库
pnpm add link:<本仓库路径>

# 2. 把包名加进 profile/package.json 的 dsh.profile.bundles
#    "dsh-skill-jnkgg"

# 3. 重启 DSH
```

装完在 **设置 → 技能库管家** 里添加你的库路径即可。

## 配置

`~/.dsh/skill-jnkgg/config.json`（设置页或 `skill_jnkgg` 工具改，自动 `.bak` 备份）：

```json
{
  "enabled": true,
  "libraries": [
    {
      "path": "~/skills/my-game-skills/skills",
      "name": "gamedev",
      "enabled": true,
      "maxVisible": 8,
      "keywords": ["游戏", "UI", "音效"]
    }
  ],
  "maxVisibleDefault": 8,
  "descMaxChars": 160,
  "scanTtlSec": 10,
  "loadBodyLimit": 200000,
  "pickMode": "keywords"
}
```

- `keywords` 留空 → 自动分析库内容提取主题
- `maxVisible: 0` → 全部隐藏，但仍可通过 `/名字`、`search`、`load` 取回
- `pickMode: "name"` → 退回按名字字母序

## 工具

对话里可直接调 `skill_jnkgg`：

| action | 作用 |
|---|---|
| `status` | 各库条数、可见上限、关键词来源（manual / auto） |
| `search` | 按关键词搜全部技能（含隐藏的），支持中文 |
| `load` | 按名字取技能正文全文 |
| `list` | 列某个库的全部技能 |
| `analyze` | 自动分析某个库，返回建议关键词 |
| `config` | 读/改配置 |
| `rescan` | 清缓存并通知宿主刷新目录 |

## 设计红线（都是踩过坑的）

- 顶层 `inject` 只写 `['skills']`；`tools` / `webServer` 一律 `ctx.get` 懒取
  （写成 `inject: ['tools']` 会让 cordis 依赖解析卡死、宿主起不来）
- 每处扫描 / 解析 / 注册独立 `try/catch`，插件坏了绝不拖垮 DSH 启动
- 设置页由 client 半边 `slots.inject('settings.section')` 注册
  （宿主端没有 `webApp.settings.section` 这个 API）
- 路由用 `webServer.register({ kind: 'prefix', path, handler(req,res) })`
- **配置一变必须调 `control.invalidate()`**，否则宿主一直用缓存的旧目录
- 配置原子写（tmp + rename），写前 `.bak`

## 检索能力实测

用 10 个互不相关的领域（烹饪/摄影/园艺/编程/医学/金融/教育/物流/建筑/心理）各造一套假壳技能库，
中英文各 50 次查询：

```
中文搜索   50/50 = 100%
英文搜索   50/50 = 100%
```

覆盖的匹配能力：
- **字面重合**：库里有「面包烘焙」，查「面包」命中
- **词干变体**：`deduction` ↔ `deductions`、`recital` ↔ `recitals`、`run` ↔ `running`
- **中英混排**：`X光`、`CT扫描`、`AI绘图`、`B超`
- **中文子串**：查「多肉」，标签「多肉浇水」命中
- **不依赖预置词表**：测试领域全都没写进别名表

### 诚实说明这个 100%

测试用的技能和查询，字面上是能对上的（我写 `Bread baking`，查「面包」）。
真正难的是**同义改写**，这类会漏：

| 库里写的 | 用户可能问 | 结果 |
|---|---|---|
| `filing` | 报税 | 漏 |
| `journal entries` | 凭证 | 漏 |
| `authorship` | 侵权 | 漏 |

**这是库内容的边界，不是检索机制的缺陷**——库里没有那个词，谁也变不出来。
兜底办法：加载 `库名-library` 拿到全量索引（每条都带中文标签），人工扫一眼就能找到。

## 已知边界

- 中文别名表是手工维护的（`CN_ALIAS` 游戏专用 + `CN_COMMON` 通用兜底），
  覆盖常见说法；生僻表达可能搜不到（整库入口仍可触发，读索引自己找）
- 单字查询（如只打「光」）会同时命中多个相关内容——正常使用不会只打一个字
- 自动主题分析是纯统计（词频 + 区分度加权），不做语义理解；
  主题特别隐晦的库建议手填关键词
- 判定"单一主题库"依赖领域词表命中率 ≥60%，冷门领域可能被判为混杂库
  （会被当混杂库处理：关键词精选 + 主题概览，不会失效）

## 来源与致谢

**这个项目不是从零开始的。** 核心机制与接口用法都来自阅读其他开源项目，
本仓库的贡献是在此之上针对「大型技能库」做的优化与产品化。
完整来源与边界声明见 [NOTICE](./NOTICE)。

### 学了机制的项目

- **[Jesse-njx/dsh-skillport](https://github.com/Jesse-njx/dsh-skillport)**（MIT）— 最重要的一位
  - 学到的：向宿主 `ctx.skills` 注册 SkillProvider 的三段式（`name`/`list`/`get`）；
    "目录限量"设计（`maxIndexEntries`：超出名额的不删除，降级为 user-invocable，
    仍可点名调用/被搜索）；宿主已挂原生 provider 时避免重复扫描
  - 本仓库不同：改为以「库」为单位管理，加了关键词打分、自动主题分析、中文别名、
    主题分散选取、库入口 router、可视化设置面

- **宿主内置 `dsh-personalized-pages` provider**（DeepSeek Harness 官方实现）
  - 学到的：`registerProvider((control) => provider)` 的确切调用形状；
    SkillCandidate 字段约定（`provider`/`source`/`rank`/`locator`/`invocation`，
    含 `modelInvocable` 与 `userInvocable` 的语义区分）；`control.invalidate()`
    用于让宿主目录缓存失效

- **[sorcerai/skill-router](https://github.com/sorcerai/skill-router)**
  - 学到理念：**懒路由** —— 整库只暴露极少入口，正文按需加载而非全量注入
  - 未使用其代码（它是 MCP 三工具形态）

- **[legendtkl/agentic-skill-router](https://github.com/legendtkl/agentic-skill-router)**
  - 学到理念：**纯本地路由不依赖 embedding**；"disable 不等于 delete，可恢复可取回"
  - 未使用其代码

### 测试用技能库（未复制任何内容）

- **[gamedev-skills/awesome-gamedev-agent-skills](https://github.com/gamedev-skills/awesome-gamedev-agent-skills)**
  （Apache-2.0）— 开发期用它做真库测试（77 条）。
  本仓库**不包含也不分发**该项目的任何文件。

### 本仓库原创

以「库」为单位的配置模型、关键词打分算法、区分度加权、中英双向别名表、
自动主题分析（纯统计零 LLM）、领域判定、主题分散选取、库入口动态描述、
分组索引生成、可视化设置面、配置原子写入。

## License

MIT

