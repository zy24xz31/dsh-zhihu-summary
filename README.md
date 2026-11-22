# dsh-zhihu-summary (v0.3.1)

基于本机知乎登录态的 DSH（DeepSeek Harness）非官方知乎总结插件：支持在手机原生界面（ccch1mneyyy/dsh-Go）、网页版工作台以及 Windows / macOS / Linux 桌面环境使用，可让 AI 辅助完成内容总结、正文与评论区看图、搜索、查答主、管理收藏夹与起草回答/文章草稿。

> ## ⚠️ 重要声明与使用警告（请务必阅读）
>
> 1. **完全由 AI 许愿式编程（Vibe Coding）生成**：本项目几乎全部代码均由用户通过自然语言向大模型提出需求并生成/拼接完成，**作者本人没有任何专业软件工程开发与长期维护能力**，不保证代码质量、架构合理性、安全性或未来接口变更后的持续可用性。
> 2. **使用前请务必严格审核源码**：本插件会直接读取、保存你本机的知乎登录 Cookie（`accounts.json`），会在本地挂载 `/zhihu` 网页控制台与风控代理路由，并包含知乎请求签名相关代码（如 `lib/zse96-core.cjs`）。**强烈建议你在安装或运行前逐行审计所有源码**，切勿在未确认代码安全性的情况下盲目运行或在不信任的环境中暴露端口。
> 3. **平台风控与账号风险自负**：本插件基于知乎网页/客户端非公开接口逆向与模拟请求实现，并非知乎官方提供或授权的 SDK/API。频繁调用或异常行为可能触发知乎安全验证（403 / 人机校验）、限流，甚至导致账号被限制功能或封禁。**由此产生的一切账号、数据或使用风险均由使用者自行承担。**
> 4. **合规与无担保声明**：本项目按“现状”（AS IS）基于 MIT 协议开源，不提供任何明示或暗示的担保。仅限个人学习、技术研究与个人效率辅助，严禁用于恶意爬虫、批量刷量、自动化营销、绕过付费墙或任何违反知乎《服务协议》及适用法律法规的用途。本项目与知乎（Zhihu）及 DeepSeek / DSH 官方均无任何隶属、合作或背书关系。

---

## 能力一览

### 对话工具（16 个，可在聊天里直接使唤）
| 工具 | 作用 |
| --- | --- |
| `zhihu_account_status` | 查看登录状态、账号列表、风控情况与设置 |
| `zhihu_home_digest` | 主页推荐前 N 条非付费内容（含配图索引） |
| `zhihu_hot_digest` | 热榜问题 + 每题多个高赞回答 |
| `zhihu_evaluate` | 评估收藏夹 / 专栏 / 盐选作品是否值得读 |
| `zhihu_read_url` | 读取单个知乎链接正文、配图索引（最多 300 张）与高赞评论（支持 `withImages` 临时开关） |
| `zhihu_download_images` | 按需下载知乎正文/评论区配图（仅放行 `*.zhimg.com`）到本机临时缓存，供 `read_image` 视觉读图 |
| `zhihu_collections` | 列出收藏夹，或分页读取收藏夹内容 |
| `zhihu_manage_collection` | 批量添加 / 取消收藏（2.4~3.8 秒随机间隔） |
| `zhihu_comments` | 读取回答、文章、想法、问题的评论区（含评论配图与楼中楼子回复） |
| `zhihu_search` | 按关键词搜索回答、文章与问题 |
| `zhihu_member` | 读取用户主页简介、获赞统计、真实动态流与代表作 |
| `zhihu_question_answers` | 分页读取某问题下的回答列表（支持默认热度 / 最新发布排序与游标翻页） |
| `zhihu_follow` | 读取关注的人动态流（含回答、文章、想法，自动过滤广告与付费内容） |
| `zhihu_notifications` | 读取通知收件箱（评论回复、回答邀请、赞同感谢、新关注、总览） |
| `zhihu_answer_draft` | 查看 / 保存 / 删除回答草稿（自动 Markdown 转富文本，默认防覆盖，**绝不自动公开发布**） |
| `zhihu_article_draft` | 列出 / 查看 / 新建 / 更新 / 删除专栏文章草稿（自动 Markdown 转富文本，默认防覆盖，**绝不自动公开发布**） |

### 正文与评论读图 & 数学公式
- **数学公式自动还原**：知乎正文里的 LaTeX 公式图片（`ztext-math` / `equation?tex=`）会自动还原为 `$公式$` 纯文本，不浪费图片额度。
- **支持正文与评论区配图**：可提取 `<figure>` / `<img>` 以及评论区的 `comment_img` / `comment_sticker` 链接。
- **三种读图模式**（可在「设置 → 知乎总结」随时切换，或调用 `zhihu_read_url` 时用 `withImages` 单次覆盖）：
  - `index`（默认·按需读图）：正文原位保留 `[图1]` / `[图1: 图注]` 锚点并返回图片清单，AI 觉得需要或你开口要看图时，再调用 `zhihu_download_images` 拉图后视觉查看。
  - `auto`（自动拉图）：读取单个链接（`zhihu_read_url`）时自动把正文前 N 张配图（默认 4 张，可调 1–15）下载到本地临时缓存供直接看图。
  - `off`（关闭读图）：纯文字模式，只还原数学公式，不附图片清单。
- **缓存与安全**：下载仅放行知乎图床（`*.zhimg.com`），缓存在 `~/.dsh/dsh-zhihu-summary/img-cache/`（Windows 为 `%USERPROFILE%\.dsh\dsh-zhihu-summary\img-cache\`），超过 24 小时或超出 80 张自动清理。

---

## 安装步骤（请在审阅源码后安装）

### 方式 A：Linux / DSH 手机端（Ubuntu proot）
1. 克隆仓库到 `~/.dsh/dsh-go/plugins/dsh-zhihu-summary`：
   ```bash
   mkdir -p ~/.dsh/dsh-go/plugins
   git clone https://github.com/zy24xz31/dsh-zhihu-summary.git ~/.dsh/dsh-go/plugins/dsh-zhihu-summary
   ```
2. 安装依赖并添加到 DSH `web` profile：
   ```bash
   cd ~/.dsh/dsh-go/plugins/dsh-zhihu-summary
   npm install
   dsh plugin --profile web add ~/.dsh/dsh-go/plugins/dsh-zhihu-summary
   ```
3. 在 DSH App 的 **「引擎」** 页面重启本地引擎。

### 方式 B：Windows 电脑（DSH Web / Desktop）
1. 打开 PowerShell，克隆仓库到本机插件目录（例如 `%USERPROFILE%\.dsh\plugins\dsh-zhihu-summary`）：
   ```powershell
   New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\plugins" | Out-Null
   git clone https://github.com/zy24xz31/dsh-zhihu-summary.git "$env:USERPROFILE\.dsh\plugins\dsh-zhihu-summary"
   ```
2. 安装依赖并加入 `web` profile（或你在用的 profile）：
   ```powershell
   cd "$env:USERPROFILE\.dsh\plugins\dsh-zhihu-summary"
   npm install
   dsh plugin --profile web add "$PWD"
   ```
   > Windows 下原生手机端面板 (`dshGo`) 会自动跳过，16 个对话工具、网页端工作台、设置页和 `/zhihu/console` 均可正常使用；如需使用「本机浏览器预热扫码」，会自动查找本机 Chrome / Edge。
3. 重启 `dsh web`（或 DSH 服务端）即可。

---

## 界面入口

- **手机端（dsh-go 原生界面）**：输入框 `+` 号 →「知乎总结」面板（含主页推荐、知乎热榜、关注动态、搜知乎、我的收藏夹、读评论区、问题回答、查答主、评论通知、代答草稿、写文章草稿、评收藏/盐选、总结链接等快捷按钮）；账号面板在插件菜单 →「知乎账号」。
- **网页端**：左侧主导航「知乎总结」工作台，以及「设置 → 知乎总结」（账号管理、抓取条数/字数上限、正文读图模式与拉图张数设置）。
- **独立控制台**：`/zhihu/console`（需先通过 DSH 网页鉴权）。

---

## 登录与风控说明

- **登录方式**：在插件面板「知乎账号与设置」或网页控制台中，支持**知乎 App 扫码登录**或**粘贴浏览器 Cookie（含 `z_c0`）导入**。
- **隐私安全**：账号凭证只保存在本机 `~/.dsh/dsh-zhihu-summary/accounts.json`（权限 `0600`），不会写入插件源码目录，也不会随代码仓库分发。
- **风控处理**：若触发知乎安全验证，可点面板中的 **「复制验证链接」** 到浏览器完成验证，或在控制台点 **「去过验证」**，完成后再继续使用。建议将 `zhihu.com` 设为直连以减少触发频率。
- **参数调节**：抓取上限与读图模式可在「设置 → 知乎总结」里调整，保存后立即生效。
