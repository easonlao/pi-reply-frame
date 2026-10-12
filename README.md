# pi-reply-frame

给 pi 的**助手回复正文**套一个圆角框，长回复一眼就能找到开头。**思考块不套框**。

```
  让我先想想这个问题          ← thinking，原样输出
  好像有两种做法

╭─ 回复 ──────────────────────────────╮
│ ## 结论                             │
│ 第一种做法更好，因为 blah blah      │
│                                     │
│ ## 细节                             │
│ 第二点                              │
╰─────────────────────────────────────╯
```

![效果截图](https://raw.githubusercontent.com/easonlao/pi-reply-frame/main/screenshot.png)

## 安装

```bash
pi install /home/easonlao/pi-reply-frame
```

然后 `/reload`。

装完之后**要删掉** `~/.pi/agent/extensions/reply-frame.ts`（如果还在的话），否则同一个扩展会被加载两次。有幂等保护不会出现两个框，但没必要留着。

## 卸载

```bash
pi remove /home/easonlao/pi-reply-frame
```

## 配置

改 `extensions/reply-frame.ts` 顶部的常量，然后 `/reload`。

| 常量 | 默认 | 作用 |
| --- | --- | --- |
| `LABEL` | `"回复"` | 顶边上的字。`""` = 光板框 |
| `COLOR` | `"customMessageLabel"` | 框的颜色，填主题里的颜色名 |
| `MIN_LINES` | `1` | 正文少于这么多行就不套框 |
| `OPEN_WHILE_STREAMING` | `true` | 流式输出时先不画底边 |

### 关于 `COLOR`

**别用 `"accent"` 或 `"border"`**——几乎所有主题里这两个是同一个颜色，而工具框（pi-rounded-tools 之类）用的就是 `border`，结果两个框长得一模一样。

以 tokyo-night 为例可选的颜色（括号内是该主题下的实际颜色）：

| 颜色名 | tokyo-night 下的颜色 |
| --- | --- |
| `customMessageLabel` / `mdListBullet` | 紫 `#bb9af7` ← 默认 |
| `mdHeading` / `warning` | 黄 `#e0af68` |
| `success` / `mdCodeBlock` | 绿 `#9ece6a` |
| `error` | 粉红 `#f7768e` |
| `borderAccent` / `mdCode` | 青 `#7dcfff` |

## 实现说明

pi 没有给"助手消息"开渲染口子——`registerMessageRenderer` 只能注册自定义消息类型，管不到内置的 `role: "assistant"`。所以这里用的是 monkey-patch：把 pi 从包根导出的 `AssistantMessageComponent.prototype.render` 包一层，在渲染好的文本行外面加框。

只包 `render`（已经渲染完的行），**不复制** pi 的 `updateContent` 逻辑。这一点是刻意的：`updateContent` 是组装内容的地方，pi 每加一个新特性（markdown 转换器、mermaid 渲染、截断提示）都会改它，任何复制它的扩展都会在 pi 升级后静默丢功能。

正文和思考块的区分：思考块是 pi 里唯一被 `MouseRegion` 包起来的子组件，而 pi 渲染时会把每个子组件的行数记在 `mouseLayout` 里，所以能按行数精确切出思考块的范围。切不出来（pi 改了结构）就退化成"整条消息一个框"，不会报错。

其它已处理的细节：

- **幂等**：`/reload` 和子会话都会重新执行扩展文件，所以补丁状态记在 prototype 上（`Symbol.for`），保证 `render` 上永远只有一层补丁。
- **鼠标坐标**：框多出边框行、正文右移了 2 列，所以逐行做了坐标映射，点思考块展开不会点偏。
- **OSC 133**：pi 贴在消息首尾行的终端标记会挪到框的最外圈。
- **窄终端**：宽度小于 10 列时直接不画框。

## 已知边界

- 折叠 thinking 时（settings 里 `hideThinkingBlock: true`，或用快捷键折叠），那行 `Thinking...` 是普通文本、不是 `MouseRegion`，所以**会被框进去**。
- 一条消息里如果有多个文字块（文字→工具→文字 全在同一条消息里），会有多个框。

## License

MIT
