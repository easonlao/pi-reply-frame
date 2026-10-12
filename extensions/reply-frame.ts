/**
 * Reply frame —— 给助手的**回复正文**套一个圆角框，一眼看清回复从哪开始、到哪结束。
 * 思考块（thinking）不套框，原样输出。
 *
 * 做法：把 pi 的 AssistantMessageComponent.render 包一层。
 * 只包 render（已经渲染好的文本行），**不复制** pi 的 updateContent 逻辑——
 * 复制那种逻辑的话，pi 每加一个新功能（markdown 转换器、mermaid 渲染、截断提示）副本就会漏掉，
 * pi-thinking-box 1.5.0 就是这么把用户的 markdown 转换器弄没的。
 *
 * 怎么区分正文和思考块：思考块在 pi 里是唯一被 MouseRegion 包起来的子组件，
 * 而 pi 渲染时会把每个子组件的行数记在 mouseLayout 里，所以能精确切出哪些行属于思考块。
 * 万一切不出来（pi 改了结构），就退化成"整条消息一个框"，不会报错。
 *
 * 注意：这是 monkey-patch。用的是 pi 从包根导出的 AssistantMessageComponent——
 * 打包版 pi 里，插件 import 到的就是正在运行的那个类，所以改 prototype 生效。
 * 删掉这个目录就完全恢复原样。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { MouseRegion, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// ─── 配置：改这里，然后 /reload ─────────────────────────────────────────

/** 顶边上的字。改成 "" 就是光板框。 */
const LABEL = "回复";

/**
 * 框用主题里的哪个颜色名。
 *
 * ⚠️ 别用 "accent" 或 "border"——几乎所有主题里这两个是同一个颜色，而工具框用的就是 border，
 * 结果就是两个框长得一模一样。
 *
 * 以 tokyo-night 为例，可选的（括号里是该主题下的实际颜色）：
 *   customMessageLabel / mdListBullet → 紫 #bb9af7   ← 当前用的，和蓝色工具框区分明显
 *   mdHeading / warning              → 黄 #e0af68
 *   success / mdCodeBlock            → 绿 #9ece6a
 *   error                            → 粉红 #f7768e
 *   borderAccent / mdCode            → 青 #7dcfff
 */
const COLOR = "customMessageLabel";

/** 正文少于这个行数就不套框。想过滤掉"让我看看"这类一句话，改成 3 试试。 */
const MIN_LINES = 1;

/** 回复还在流式输出时先不画底边，免得底边跟着文字一路往下跑。 */
const OPEN_WHILE_STREAMING = true;

// ────────────────────────────────────────────────────────────────────────

const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" } as const;

// pi 贴在助手消息首尾行开头的 OSC 133 标记（终端用它识别"这是一段输出"）
const OSC_START = "\x1b]133;A\x07";
const OSC_END = "\x1b]133;B\x07";
const OSC_FINAL = "\x1b]133;C\x07";

// pi 把当前主题挂在 globalThis 上，每次渲染读一次，切主题后自动跟上
const THEME_KEYS = [
	Symbol.for("@earendil-works/pi-coding-agent:theme"),
	Symbol.for("@mariozechner/pi-coding-agent:theme"),
];

type ThemeLike = { fg(color: string, text: string): string };

function currentTheme(): ThemeLike | undefined {
	for (const key of THEME_KEYS) {
		const theme = (globalThis as Record<symbol, unknown>)[key] as Partial<ThemeLike> | undefined;
		if (theme && typeof theme.fg === "function") return theme as ThemeLike;
	}
	return undefined;
}

/** 拿到上色函数；主题里没有这个颜色名就退化成不上色。 */
function painter(): (text: string) => string {
	const theme = currentTheme();
	if (!theme) return (text) => text;
	try {
		theme.fg(COLOR, ""); // 先探一下这个颜色名存不存在
	} catch {
		return (text) => text;
	}
	return (text) => theme.fg(COLOR, text);
}

function topEdge(width: number, paint: (text: string) => string): string {
	const inner = Math.max(0, width - 2);
	if (!LABEL) return paint(BOX.tl + BOX.h.repeat(inner) + BOX.tr);

	const shown = ` ${LABEL} `;
	const fill = Math.max(0, inner - 1 - visibleWidth(shown));
	return paint(BOX.tl + BOX.h) + paint(shown) + paint(BOX.h.repeat(fill) + BOX.tr);
}

function bottomEdge(width: number, paint: (text: string) => string): string {
	return paint(BOX.bl + BOX.h.repeat(Math.max(0, width - 2)) + BOX.br);
}

function isBlank(line: string): boolean {
	return stripTerminalSequences(line).trim() === "";
}

/** 思考块是 pi 里唯一被 MouseRegion 包起来的子组件。 */
function isThinkingChild(child: unknown): boolean {
	if (child instanceof MouseRegion) return true;
	// 万一 MouseRegion 是另一份拷贝，靠类名兜底
	return (child as { constructor?: { name?: string } })?.constructor?.name === "MouseRegion";
}

type Segment = { thinking: boolean; lines: string[] };

/**
 * 按子组件把渲染好的行切成段，并标出哪些段属于思考块。
 * 切不出来就返回一整段"非思考"，效果等于整条消息一个框。
 */
function splitSegments(component: any, lines: string[]): Segment[] {
	const container = Array.isArray(component.children) ? component.children[0] : undefined;
	const layout = container?.mouseLayout;
	if (!layout || !Array.isArray(layout.children)) return [{ thinking: false, lines }];

	let total = 0;
	for (const entry of layout.children) total += entry?.height ?? 0;
	if (total !== lines.length) return [{ thinking: false, lines }];

	const segments: Segment[] = [];
	let offset = 0;
	for (const entry of layout.children) {
		const height = entry?.height ?? 0;
		const slice = lines.slice(offset, offset + height);
		offset += height;

		const thinking = isThinkingChild(entry?.component);
		const previous = segments[segments.length - 1];
		if (previous && previous.thinking === thinking) previous.lines.push(...slice);
		else segments.push({ thinking, lines: slice });
	}
	return segments;
}

/** 输出行 → 内容行号 + 左缩进；null 表示这行是边框，不可点。 */
type Hit = { line: number; indent: number } | null;

// 补丁状态记在 prototype 上。用 Symbol.for 是为了跨模块实例也能认出来——
// /reload 和子会话（pi-subagents-lite 那种）都会重新执行这个文件，而 prototype 是全局的。
const PATCH_STATE = Symbol.for("pi-reply-frame:state");

type PatchState = { originalRender: any; originalHandleMouse: any };

export default function (pi: ExtensionAPI) {
	const proto = AssistantMessageComponent.prototype as unknown as Record<string, any>;

	// 自检：pi 正在用的那个类上有这些内部方法。拿到的类没有，说明不是同一个，别硬 patch。
	if (typeof proto.updateContent !== "function" || typeof proto.setOutputPad !== "function") {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify("reply-frame：拿到的 AssistantMessageComponent 不是 pi 正在用的那个，框不会生效。", "warning");
		});
		return;
	}

	// 幂等：这个文件会被反复执行，如果每次都往上一层层地叠，框就会一层套一层。
	// 所以第一次补丁时把 pi 的原版方法存进 prototype，之后每次都复用同一份原版，
	// 保证 render / handleMouse 上永远只有一层补丁。
	const previous = proto[PATCH_STATE] as PatchState | undefined;
	const originalRender = previous ? previous.originalRender : proto.render;
	const originalHandleMouse = previous ? previous.originalHandleMouse : proto.handleMouse;
	proto[PATCH_STATE] = { originalRender, originalHandleMouse } satisfies PatchState;

	proto.render = function (width: number) {
		this.__replyFrame = undefined;
		if (!(width >= 10)) return originalRender.call(this, width);

		// 左右各让出 2 列给边框
		const innerWidth = Math.max(1, width - 4);
		const lines = originalRender.call(this, innerWidth) as string[];
		if (!Array.isArray(lines) || lines.length === 0) return lines;

		// 把 OSC 133 标记从内容行上摘下来，最后挂到整块的最外圈
		let head = "";
		let tail = "";
		if (lines[0].startsWith(OSC_START)) {
			head = OSC_START;
			lines[0] = lines[0].slice(OSC_START.length);
		}
		const lastIndex = lines.length - 1;
		const tailMarker = OSC_END + OSC_FINAL;
		if (lines[lastIndex].startsWith(tailMarker)) {
			tail = tailMarker;
			lines[lastIndex] = lines[lastIndex].slice(tailMarker.length);
		}

		const segments = splitSegments(this, lines);
		const paint = painter();
		const side = paint(BOX.v);
		const streaming = OPEN_WHILE_STREAMING && Boolean(this.isStreaming);

		const out: string[] = [];
		const lineMap: Hit[] = [];
		let contentLine = 0; // 正在处理 lines 里的第几行

		// 内容行：原样搬出去，记下它对应 lines 里的哪一行
		const pushContent = (line: string) => {
			lineMap.push({ line: contentLine, indent: 0 });
			out.push(line);
			contentLine++;
		};
		// 边框行：不可点
		const pushChrome = (line: string) => {
			lineMap.push(null);
			out.push(line);
		};

		segments.forEach((segment, index) => {
			if (segment.thinking) {
				for (const line of segment.lines) pushContent(line);
				return;
			}

			// 正文：掐掉首尾空行（空行放到框外，保留间距）
			let start = 0;
			let end = segment.lines.length;
			while (start < end && isBlank(segment.lines[start])) start++;
			while (end > start && isBlank(segment.lines[end - 1])) end--;
			const body = segment.lines.slice(start, end);

			for (let i = 0; i < start; i++) pushContent(segment.lines[i]);

			if (body.length === 0 || body.length < MIN_LINES) {
				for (const line of body) pushContent(line);
			} else {
				pushChrome(topEdge(width, paint));
				for (const line of body) {
					const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
					lineMap.push({ line: contentLine, indent: 2 });
					out.push(side + " " + line + pad + " " + side);
					contentLine++;
				}
				const isLast = index === segments.length - 1;
				if (!(streaming && isLast)) pushChrome(bottomEdge(width, paint));
			}

			for (let i = end; i < segment.lines.length; i++) pushContent(segment.lines[i]);
		});

		if (out.length === 0) return lines;
		out[0] = head + out[0];
		out[out.length - 1] = tail + out[out.length - 1];

		// 鼠标坐标要按这个映射回退（点思考块展开时用）
		this.__replyFrame = { lineMap, innerWidth, innerHeight: lines.length };
		return out;
	};

	// 框多出边框行、正文还右移了 2 列，鼠标坐标得映射回去，否则点思考块会点偏。
	proto.handleMouse = function (event: any) {
		const state = this.__replyFrame;
		if (!state || !event || typeof event.y !== "number") return originalHandleMouse.call(this, event);

		const hit = state.lineMap[event.y];
		if (!hit) return undefined;

		const shifted = { ...event, y: hit.line, width: state.innerWidth, height: state.innerHeight };
		if (hit.indent && typeof event.x === "number") shifted.x = event.x - hit.indent;
		return originalHandleMouse.call(this, shifted);
	};
}
